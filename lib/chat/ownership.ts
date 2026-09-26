export interface OwnedRow {
  user_id: string;
}

/** Throws nothing — pure boolean check used before trusting any row from the client's requested ID. */
export function isOwnedBy(row: OwnedRow | null | undefined, userId: string): boolean {
  return !!row && row.user_id === userId;
}

export interface MinimalMessage {
  id: string;
  conversation_id: string;
  role: "user" | "assistant" | "system";
  status?: "complete" | "incomplete";
}

export interface RetryValidationInput {
  /** The message the client wants regenerated. Null if it doesn't exist / wasn't found. */
  targetMessage: MinimalMessage | null;
  /**
   * Every message in the conversation strictly after the target, in
   * chronological order. Empty if the target is currently the last
   * message (the common case: the first generation attempt failed).
   */
  messagesAfterTarget: MinimalMessage[];
  conversationId: string;
}

export type RetryValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason: "not_found" | "wrong_conversation" | "not_a_user_message" | "already_answered";
    };

/**
 * A retry regenerates a reply to an existing user message without
 * inserting a duplicate user row. It's only valid when every attempt
 * since that message failed or was cut off (role=assistant,
 * status=incomplete) — once a *complete* assistant reply exists for it,
 * the conversation has moved on and a new message should be sent
 * instead of retrying an old turn.
 */
export function validateRetryTarget(input: RetryValidationInput): RetryValidationResult {
  const { targetMessage, messagesAfterTarget, conversationId } = input;

  if (!targetMessage) return { ok: false, reason: "not_found" };
  if (targetMessage.conversation_id !== conversationId) {
    return { ok: false, reason: "wrong_conversation" };
  }
  if (targetMessage.role !== "user") return { ok: false, reason: "not_a_user_message" };

  const hasSuccessfulReply = messagesAfterTarget.some(
    (m) => m.role === "assistant" && m.status !== "incomplete"
  );
  const hasNonAssistantAfter = messagesAfterTarget.some((m) => m.role !== "assistant");

  if (hasSuccessfulReply || hasNonAssistantAfter) {
    return { ok: false, reason: "already_answered" };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Phase 5: regenerate + edit
// ---------------------------------------------------------------------------

/** A persisted message row with the fields the Phase 5 checks need. */
export interface StoredMessage extends MinimalMessage {
  user_id: string;
  content: string;
  created_at: string;
  metadata?: unknown;
}

export type RegenerateFailureReason =
  | "not_found"
  | "wrong_conversation"
  | "not_owner"
  | "not_latest"
  | "not_an_assistant_message"
  | "no_user_message";

export type RegenerateValidationResult =
  | { ok: true; assistantMessage: StoredMessage; userMessage: StoredMessage }
  | { ok: false; reason: RegenerateFailureReason };

/**
 * Regenerate replaces the assistant reply at the *end* of a conversation.
 * Only the latest message may be regenerated: replacing a reply in the
 * middle would leave later turns that were written in response to text
 * that no longer exists (use edit-and-resend to change earlier history).
 *
 * `latestMessages` is the conversation's two most recent messages, newest
 * first — enough to identify both the reply being replaced and the user
 * message it answers, in a single bounded query.
 *
 * Ownership is checked explicitly on top of RLS (which already hides other
 * users' rows) so a foreign or forged id fails the same safe way.
 */
export function validateRegenerateTarget(input: {
  targetId: string;
  latestMessages: StoredMessage[];
  conversationId: string;
  userId: string;
}): RegenerateValidationResult {
  const { targetId, latestMessages, conversationId, userId } = input;
  const latest = latestMessages[0];
  const previous = latestMessages[1];

  if (!latest) return { ok: false, reason: "not_found" };
  if (latest.conversation_id !== conversationId) return { ok: false, reason: "wrong_conversation" };
  if (latest.user_id !== userId) return { ok: false, reason: "not_owner" };
  if (latest.id !== targetId) return { ok: false, reason: "not_latest" };
  if (latest.role !== "assistant") return { ok: false, reason: "not_an_assistant_message" };
  if (!previous || previous.role !== "user" || previous.user_id !== userId) {
    return { ok: false, reason: "no_user_message" };
  }

  return { ok: true, assistantMessage: latest, userMessage: previous };
}

export type EditFailureReason =
  | "not_found"
  | "wrong_conversation"
  | "not_owner"
  | "not_a_user_message";

export type EditValidationResult =
  | { ok: true; message: StoredMessage }
  | { ok: false; reason: EditFailureReason };

/**
 * Only the caller's own *user* messages may be edited — never an
 * assistant message, and never anything outside the named conversation.
 */
export function validateEditTarget(input: {
  target: StoredMessage | null | undefined;
  conversationId: string;
  userId: string;
}): EditValidationResult {
  const { target, conversationId, userId } = input;

  if (!target) return { ok: false, reason: "not_found" };
  if (target.conversation_id !== conversationId) return { ok: false, reason: "wrong_conversation" };
  if (target.user_id !== userId) return { ok: false, reason: "not_owner" };
  if (target.role !== "user") return { ok: false, reason: "not_a_user_message" };

  return { ok: true, message: target };
}

/** User-facing text for every regenerate/edit rejection. Deliberately vague about *why* a foreign id failed. */
export const REGENERATE_FAILURE_MESSAGES: Record<RegenerateFailureReason, string> = {
  not_found: "That response could not be found.",
  wrong_conversation: "That response could not be found.",
  not_owner: "That response could not be found.",
  not_latest: "Only the most recent response can be regenerated. Edit an earlier message to change earlier history.",
  not_an_assistant_message: "Only assistant responses can be regenerated.",
  no_user_message: "There's no message to regenerate a response for.",
};

export const EDIT_FAILURE_MESSAGES: Record<EditFailureReason, string> = {
  not_found: "That message could not be found.",
  wrong_conversation: "That message could not be found.",
  not_owner: "That message could not be found.",
  not_a_user_message: "Only your own messages can be edited.",
};

/**
 * conversation_documents rows exist only because a user message attached
 * that document (app/api/chat/route.ts is the sole writer). After an edit
 * removes messages, any link no longer justified by a *remaining* user
 * message's metadata is stale and would keep grounding answers in a
 * document the surviving branch never attached. Returns those document ids.
 */
export function findStaleDocumentIds(
  linkedDocumentIds: string[],
  remainingUserMessageMetadata: unknown[]
): string[] {
  const stillReferenced = new Set<string>();
  for (const metadata of remainingUserMessageMetadata) {
    if (metadata && typeof metadata === "object" && "documentId" in metadata) {
      const id = (metadata as { documentId: unknown }).documentId;
      if (typeof id === "string") stillReferenced.add(id);
    }
  }
  return linkedDocumentIds.filter((id) => !stillReferenced.has(id));
}
