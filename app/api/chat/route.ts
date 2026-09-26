import { createClient } from "@/lib/supabase/server";
import { chatRequestSchema } from "@/lib/validation/chat";
import { deriveTitle } from "@/lib/chat/title";
import { buildGeminiHistory, MAX_HISTORY_MESSAGES, type HistoryMessage } from "@/lib/chat/context";
import {
  EDIT_FAILURE_MESSAGES,
  REGENERATE_FAILURE_MESSAGES,
  findStaleDocumentIds,
  isOwnedBy,
  validateEditTarget,
  validateRegenerateTarget,
  validateRetryTarget,
} from "@/lib/chat/ownership";
import { chatError, mapUnknownError, ChatError } from "@/lib/chat/errors";
import { checkRateLimit } from "@/lib/rate-limit";
import { SYSTEM_INSTRUCTION } from "@/lib/ai/system-prompt";
import { RAG_MODE_ADDENDUM, buildRagGroundedMessage } from "@/lib/ai/rag-prompt";
import { getRetrievableDocuments, retrieveRelevantChunks, type RetrievedChunk } from "@/lib/rag/retrieval";
import { GeminiProvider } from "@/lib/ai/gemini";
import type { AiProvider } from "@/lib/ai/provider";
import type { DocumentAttachmentMetadata, MessageMetadata, SourceRef } from "@/lib/supabase/types";
 
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
 
const provider: AiProvider = new GeminiProvider();
const encoder = new TextEncoder();
 
type StreamEvent =
  | { type: "chunk"; text: string }
  | {
      type: "done";
      messageId: string;
      sources?: SourceRef[];
      /** Non-fatal: the reply was produced, but document retrieval failed so it isn't grounded. */
      notice?: "retrieval_failed";
    }
  | {
      type: "error";
      message: string;
      /** Safe, machine-readable category — lets the client distinguish auth/rate-limit/provider/etc. */
      code?: string;
      partial: boolean;
      /** Id of the incomplete assistant message the server persisted, when it persisted one. */
      messageId?: string;
    };
 
function ndjson(event: StreamEvent): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}
 
function errorResponse(error: ChatError) {
  return Response.json({ error: error.message, code: error.code }, { status: error.status });
}
 
type ServerSupabase = Awaited<ReturnType<typeof createClient>>;
 
/**
 * Loads the conversation and checks ownership explicitly (RLS already
 * hides other users' rows; a missing row and a forbidden row must both
 * fail identically so callers can't probe which ids exist).
 */
async function requireOwnedConversation(supabase: ServerSupabase, conversationId: string, userId: string) {
  const { data: conversation } = await supabase
    .from("conversations")
    .select("id, user_id")
    .eq("id", conversationId)
    .single();
  if (!conversation || !isOwnedBy(conversation, userId)) {
    throw chatError("not_found", "Conversation not found.");
  }
}
 
function asDocumentAttachment(metadata: unknown): DocumentAttachmentMetadata | null {
  if (metadata && typeof metadata === "object" && "documentId" in metadata && "filename" in metadata) {
    return metadata as DocumentAttachmentMetadata;
  }
  return null;
}
 
function toSourceRefs(chunks: RetrievedChunk[]): SourceRef[] {
  return chunks.map((chunk) => ({
    documentId: chunk.documentId,
    filename: chunk.filename,
    chunkId: chunk.chunkId,
    chunkIndex: chunk.chunkIndex,
    similarity: chunk.similarity,
    content: chunk.content,
  }));
}
 
interface AttachedDocument {
  id: string;
  filename: string;
}
 
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(chatError("invalid_request", "Request body must be valid JSON."));
  }
 
  const parsed = chatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(
      chatError("invalid_request", parsed.error.issues[0]?.message ?? "Invalid request.")
    );
  }
  const input = parsed.data;
 
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
 
  // Never trust a client-provided user id — the only identity that
  // matters is the one Supabase resolves from the session cookie.
  if (!user) {
    return errorResponse(chatError("unauthenticated", "You must be signed in."));
  }
 
  // Scoped to this authenticated user (never IP-only — see
  // lib/rate-limit.ts). Checked before any conversation/message writes so
  // a caller over the limit never pays for a partially-applied turn.
  const rateLimit = await checkRateLimit(supabase, "chat");
  if (!rateLimit.ok) {
    // Phase 6 correction: the limiter infrastructure itself failed —
    // distinct from a real 429. Fail closed (reject) rather than let
    // the request through unmetered.
    return errorResponse(
      chatError("rate_limit_unavailable", "Request protection is temporarily unavailable. Please try again in a moment.")
    );
  }
  if (!rateLimit.allowed) {
    return Response.json(
      {
        error: "You're sending messages too quickly. Please wait a moment and try again.",
        code: "rate_limited",
      },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
    );
  }
 
  let conversationId: string;
  let userMessageId: string;
  /** The plain question text for *this* turn — used as the RAG retrieval query and spliced into the grounded prompt below. */
  let questionText: string;
  let attachedDocument: AttachedDocument | null = null;
  /**
   * Set only for "regenerate": the existing assistant reply that the new
   * one replaces. It is kept until the replacement is safely persisted, so
   * a failed regeneration never costs the person their original answer.
   */
  let replaceAssistantId: string | null = null;
 
  try {
    if (input.retryMessageId) {
      // --- Retry: regenerate a reply to an already-persisted message ---
      if (!input.conversationId) {
        throw chatError("invalid_request", "conversationId is required to retry.");
      }
      conversationId = input.conversationId;
 
      const { data: conversation } = await supabase
        .from("conversations")
        .select("id, user_id")
        .eq("id", conversationId)
        .single();
      if (!conversation) {
        throw chatError("not_found", "Conversation not found.");
      }
 
      const { data: targetMessage } = await supabase
        .from("messages")
        .select("id, conversation_id, role, content, metadata, created_at")
        .eq("id", input.retryMessageId)
        .single();
 
      const { data: messagesAfter } = targetMessage
        ? await supabase
            .from("messages")
            .select("id, conversation_id, role, status")
            .eq("conversation_id", conversationId)
            .gt("created_at", targetMessage.created_at)
            .order("created_at", { ascending: true })
        : { data: null };
 
      const validation = validateRetryTarget({
        targetMessage: targetMessage ?? null,
        messagesAfterTarget: messagesAfter ?? [],
        conversationId,
      });
 
      if (!validation.ok) {
        throw chatError(
          "invalid_request",
          "That message can't be retried. Send a new message instead."
        );
      }
 
      userMessageId = input.retryMessageId;
      questionText = targetMessage!.content;
 
      // Persistence consistency (Phase 5): validation above guarantees the
      // only messages after the target are *incomplete* assistant
      // attempts. Left in place they'd reappear as "interrupted" bubbles
      // above the new answer after a refresh (the client already hides
      // them locally), so remove them now.
      const staleAttemptIds = (messagesAfter ?? []).map((m) => m.id);
      if (staleAttemptIds.length > 0) {
        const { error: cleanupError } = await supabase
          .from("messages")
          .delete()
          .in("id", staleAttemptIds)
          .eq("conversation_id", conversationId)
          .eq("role", "assistant")
          .eq("status", "incomplete");
        if (cleanupError) {
          console.error(`Failed to clear stale incomplete attempts (conversation=${conversationId}):`, cleanupError.message);
        }
      }
 
      // Unlike Phase 3, grounding no longer depends on which document (if
      // any) this specific turn's metadata names — retrieval is scoped to
      // whatever documents are associated with the *conversation* via
      // conversation_documents (resolved below, after this try/catch), so
      // there is nothing document-specific left to look up for a retry.
    } else if (input.regenerateMessageId) {
      // --- Regenerate: replace the latest assistant reply (Phase 5) ---
      //
      // Goes through this same route (same history, same RAG retrieval,
      // same Gemini call, same persistence) — there is no second AI code
      // path. Only the *latest* message may be regenerated; see
      // validateRegenerateTarget.
      conversationId = input.conversationId!;
      await requireOwnedConversation(supabase, conversationId, user.id);
 
      const { data: latestTwo } = await supabase
        .from("messages")
        .select("id, conversation_id, user_id, role, content, status, metadata, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(2);
 
      const validation = validateRegenerateTarget({
        targetId: input.regenerateMessageId,
        latestMessages: latestTwo ?? [],
        conversationId,
        userId: user.id,
      });
      if (!validation.ok) {
        throw chatError("invalid_request", REGENERATE_FAILURE_MESSAGES[validation.reason]);
      }
 
      userMessageId = validation.userMessage.id;
      questionText = validation.userMessage.content;
      replaceAssistantId = validation.assistantMessage.id;
    } else if (input.editMessageId) {
      // --- Edit + resend (Phase 5) ---
      //
      // Strategy: truncate from the edited message onward and answer the
      // edited text — no branching. messages has no UPDATE policy (and
      // this adds none), so instead of mutating the row we:
      //   1. INSERT the replacement user message (a single atomic statement),
      //   2. DELETE the original and everything after it (one atomic
      //      statement; the replacement is excluded by id),
      //   3. roll the insert back if step 2 fails.
      // At no point can a failure leave the conversation with the edited
      // message *and* the stale tail, or with neither.
      conversationId = input.conversationId!;
      await requireOwnedConversation(supabase, conversationId, user.id);
 
      const { data: target } = await supabase
        .from("messages")
        .select("id, conversation_id, user_id, role, content, status, metadata, created_at")
        .eq("id", input.editMessageId)
        .eq("conversation_id", conversationId)
        .single();
 
      const validation = validateEditTarget({ target: target ?? null, conversationId, userId: user.id });
      if (!validation.ok) {
        throw chatError("invalid_request", EDIT_FAILURE_MESSAGES[validation.reason]);
      }
 
      const original = validation.message;
      const content = input.content!;
      questionText = content;
 
      const { data: replacement, error: replacementError } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          user_id: user.id,
          role: "user",
          content,
          status: "complete",
          // Carry the document attachment over so the bubble still shows it.
          metadata: asDocumentAttachment(original.metadata),
        })
        .select("id")
        .single();
 
      if (replacementError || !replacement) {
        throw chatError("database_error", "Couldn't save your edit. Nothing was changed.");
      }
 
      const { data: removed, error: removeError } = await supabase
        .from("messages")
        .delete()
        .eq("conversation_id", conversationId)
        .eq("user_id", user.id)
        .gte("created_at", original.created_at)
        .neq("id", replacement.id)
        .select("id");
 
      if (removeError || !removed || removed.length === 0) {
        await supabase.from("messages").delete().eq("id", replacement.id);
        throw chatError("database_error", "Couldn't apply your edit. Nothing was changed.");
      }
 
      userMessageId = replacement.id;
 
      // Documents attached only by messages that were just removed must
      // stop grounding this conversation — see findStaleDocumentIds. A
      // failure here is logged, not fatal: the edit itself has succeeded.
      try {
        const [{ data: links }, { data: remainingUserMessages }] = await Promise.all([
          supabase.from("conversation_documents").select("document_id").eq("conversation_id", conversationId),
          supabase.from("messages").select("metadata").eq("conversation_id", conversationId).eq("role", "user"),
        ]);
        const stale = findStaleDocumentIds(
          (links ?? []).map((l) => l.document_id),
          (remainingUserMessages ?? []).map((m) => m.metadata)
        );
        if (stale.length > 0) {
          const { error: unlinkError } = await supabase
            .from("conversation_documents")
            .delete()
            .eq("conversation_id", conversationId)
            .in("document_id", stale);
          if (unlinkError) throw unlinkError;
        }
      } catch (error) {
        console.error(`Failed to reconcile conversation_documents after edit (conversation=${conversationId}):`, error);
      }
 
      await supabase
        .from("conversations")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", conversationId);
    } else {
      // --- New message: create/verify conversation, then persist it ---
      const content = input.content!;
      questionText = content;
 
      if (input.documentId) {
        // Verified before anything is written: an unauthorized or
        // nonexistent document must never make it into a persisted
        // message's metadata. RLS scopes this to the caller's own
        // documents already.
        const { data: doc } = await supabase
          .from("documents")
          .select("id, filename, extraction_status")
          .eq("id", input.documentId)
          .single();
        if (!doc) {
          throw chatError("not_found", "That document could not be found.");
        }
        // A document isn't retrievable until its embeddings are stored
        // (extraction_status = 'ready') — see lib/rag/pipeline.ts. Rather
        // than silently answering ungrounded or falling back to a stale
        // truncation strategy, tell the person plainly so they know to
        // wait or retry processing.
        if (doc.extraction_status === "processing") {
          throw chatError(
            "document_error",
            "This document is still being processed. Try asking again in a moment."
          );
        }
        if (doc.extraction_status === "failed") {
          throw chatError(
            "document_error",
            "This document failed to process, so it can't be used yet. Try reprocessing it from the Files page."
          );
        }
        attachedDocument = { id: doc.id, filename: doc.filename };
      }
 
      if (input.conversationId) {
        const { data: conversation } = await supabase
          .from("conversations")
          .select("id, user_id")
          .eq("id", input.conversationId)
          .single();
 
        // RLS already prevents reading another user's row, but we check
        // explicitly so a missing row and a forbidden row both fail the
        // same safe way instead of leaking which case occurred.
        if (!conversation) {
          throw chatError("not_found", "Conversation not found.");
        }
        conversationId = conversation.id;
      } else {
        const { data: created, error: createError } = await supabase
          .from("conversations")
          .insert({ user_id: user.id, title: deriveTitle(content) })
          .select("id")
          .single();
 
        if (createError || !created) {
          throw chatError("database_error", "Couldn't start a new conversation.");
        }
        conversationId = created.id;
      }
 
      const metadata: MessageMetadata | null = attachedDocument
        ? { documentId: attachedDocument.id, filename: attachedDocument.filename }
        : null;
 
      const { data: userMessage, error: insertError } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          user_id: user.id,
          role: "user",
          content,
          status: "complete",
          metadata,
        })
        .select("id")
        .single();
 
      if (insertError || !userMessage) {
        throw chatError("database_error", "Couldn't save your message.");
      }
      userMessageId = userMessage.id;
 
      if (attachedDocument) {
        // Record the conversation<->document association (a document can
        // be attached across multiple conversations, so this is a
        // separate row, not a column on either table). ignoreDuplicates
        // keeps the composite primary key intact — a repeat attach is a
        // no-op, not an error. A genuine failure here is non-fatal to
        // the chat turn itself (the answer can still be generated), but
        // it must not be swallowed silently — it's logged so a missing
        // association is diagnosable rather than a silent data gap.
        const { error: associationError } = await supabase
          .from("conversation_documents")
          .upsert(
            { conversation_id: conversationId, document_id: attachedDocument.id, user_id: user.id },
            { onConflict: "conversation_id,document_id", ignoreDuplicates: true }
          );
 
        if (associationError) {
          console.error(
            `Failed to record conversation_documents (conversation=${conversationId}, document=${attachedDocument.id}):`,
            associationError.message
          );
        }
      }
 
      // Bump the conversation's updated_at so the list re-sorts. The
      // set_updated_at trigger recomputes now() regardless of the value
      // we send.
      await supabase
        .from("conversations")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", conversationId);
    }
  } catch (error) {
    return errorResponse(error instanceof ChatError ? error : mapUnknownError(error));
  }
 
  // --- Load bounded history and kick off the real streaming response ---
  const { data: recentRows } = await supabase
    .from("messages")
    .select("id, role, content, status")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    // One extra row when regenerating, since the reply being replaced is
    // filtered out below and must not cost the model a message of context.
    .limit(MAX_HISTORY_MESSAGES + (replaceAssistantId ? 1 : 0));
 
  const history: HistoryMessage[] = (recentRows ?? [])
    // The reply being regenerated is never part of its own context.
    .filter((row) => row.id !== replaceAssistantId)
    .slice()
    .reverse()
    .map((row) => ({ role: row.role, content: row.content, status: row.status }));
 
  const geminiHistory = buildGeminiHistory(history);
 
  // --- RAG retrieval (Phase 4) ---
  //
  // Scope is the *conversation's* attached, ready documents (via
  // conversation_documents), not just whatever was attached on this one
  // turn — see docs/ARCHITECTURE.md "Retrieval scope (Phase 4)". This
  // intentionally means a document attached in an earlier turn keeps
  // grounding later questions in the same conversation without needing
  // to be re-attached every time, which is safe (and cheap) now that
  // retrieval only ever embeds the query, never the document.
  const retrievableDocuments = await getRetrievableDocuments(supabase, conversationId);
  const ragAttempted = retrievableDocuments.length > 0;
  let ragChunks: RetrievedChunk[] = [];
  let retrievalFailed = false;
 
  if (ragAttempted) {
    try {
      const result = await retrieveRelevantChunks(supabase, {
        documents: retrievableDocuments,
        query: questionText,
      });
      ragChunks = result.chunks;
    } catch (error) {
      // A transient embedding-provider failure degrades this turn to "no
      // retrieved context" rather than failing the whole chat request —
      // normal chat must keep working even when the embedding provider
      // doesn't. RAG_MODE_ADDENDUM still tells the model no relevant
      // passages were found, so it won't guess at document contents.
      console.error(`RAG retrieval failed for conversation ${conversationId}:`, error);
      ragChunks = [];
      // Surfaced to the client as a non-fatal notice on `done` so the
      // person isn't left believing this reply was grounded in their documents.
      retrievalFailed = true;
    }
  }
 
  // Document text is never persisted into messages.content (see
  // migration 0004 / ARCHITECTURE.md), so retrieved context is spliced
  // into the *current* turn's content only at request time — never
  // resent for older turns.
  if (ragAttempted && geminiHistory.length > 0) {
    const groundedText = buildRagGroundedMessage({ chunks: ragChunks, question: questionText });
    geminiHistory[geminiHistory.length - 1] = {
      role: "user",
      parts: [{ text: groundedText }],
    };
  }
 
  const systemInstruction = ragAttempted ? `${SYSTEM_INSTRUCTION}\n${RAG_MODE_ADDENDUM}` : SYSTEM_INSTRUCTION;
 
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = "";
      let closed = false;
 
      const safeEnqueue = (event: StreamEvent) => {
        if (closed) return;
        try {
          controller.enqueue(ndjson(event));
        } catch {
          closed = true;
        }
      };
 
      const onAbort = () => {
        closed = true;
      };
      request.signal.addEventListener("abort", onAbort);
 
      /**
       * Persists whatever was generated as an *incomplete* assistant
       * message and returns its id. A failed or cancelled *regeneration*
       * persists nothing: the original reply is still in the database,
       * and is what the person should keep seeing.
       */
      const persistIncomplete = async (): Promise<string | undefined> => {
        if (replaceAssistantId !== null || full.trim().length === 0) return undefined;
        const { data } = await supabase
          .from("messages")
          .insert({
            conversation_id: conversationId,
            user_id: user.id,
            role: "assistant",
            content: full,
            status: "incomplete",
          })
          .select("id")
          .single();
        return data?.id;
      };
 
      try {
        for await (const textChunk of provider.streamReply({
          systemInstruction,
          history: geminiHistory,
        })) {
          if (request.signal.aborted) break;
          full += textChunk;
          safeEnqueue({ type: "chunk", text: textChunk });
        }
 
        if (request.signal.aborted) {
          // Client disconnected. Best-effort: persist whatever we have as
          // incomplete so reopening the conversation shows it was cut
          // off, rather than silently losing it. On some serverless
          // runtimes the function may be torn down before this runs —
          // see docs/ARCHITECTURE.md "Known limitations".
          await persistIncomplete();
          return;
        }
 
        // Sources shown in the UI are always exactly the chunks that were
        // actually retrieved and placed in <retrieved_context> for this
        // turn (see lib/ai/rag-prompt.ts) — never anything parsed out of
        // the model's own reply text.
        const sources = ragChunks.length > 0 ? toSourceRefs(ragChunks) : undefined;
        const assistantMetadata: MessageMetadata | null = sources ? { sources } : null;
 
        const { data: assistantMessage, error: assistantInsertError } = await supabase
          .from("messages")
          .insert({
            conversation_id: conversationId,
            user_id: user.id,
            role: "assistant",
            content: full,
            status: "complete",
            metadata: assistantMetadata,
          })
          .select("id")
          .single();
 
        if (assistantInsertError || !assistantMessage) {
          safeEnqueue({
            type: "error",
            code: "database_error",
            message: "The response finished but couldn't be saved. Refreshing may lose it.",
            partial: true,
          });
          controller.close();
          return;
        }
 
        if (replaceAssistantId !== null) {
          // Replacement is safely stored; now retire the reply it replaces.
          // The delete must remove exactly that one row. If it doesn't
          // (database error, or another tab already replaced it), undo the
          // insert so the conversation never ends up with two competing
          // replies — the original stays and the person is told plainly.
          const { data: removed, error: removeError } = await supabase
            .from("messages")
            .delete()
            .eq("id", replaceAssistantId)
            .eq("conversation_id", conversationId)
            .select("id");
 
          if (removeError || !removed || removed.length !== 1) {
            await supabase.from("messages").delete().eq("id", assistantMessage.id);
            safeEnqueue({
              type: "error",
              code: "database_error",
              message: "The new response couldn't replace the original, so your original response was kept.",
              partial: false,
            });
            controller.close();
            return;
          }
        }
 
        await supabase
          .from("conversations")
          .update({ updated_at: new Date().toISOString() })
          .eq("id", conversationId);
 
        safeEnqueue({
          type: "done",
          messageId: assistantMessage.id,
          sources,
          notice: retrievalFailed ? "retrieval_failed" : undefined,
        });
        controller.close();
      } catch (error) {
        console.error("DEBUG - raw chat error:", error);
        const mapped = mapUnknownError(error);
 
        // Don't pretend a failed generation is complete: only persist a
        // message if we actually produced meaningful partial content, and
        // mark it explicitly incomplete either way. (Never for a
        // regeneration — see persistIncomplete.)
        const persistedId = await persistIncomplete();
 
        safeEnqueue({
          type: "error",
          code: mapped.code,
          message: mapped.message,
          partial: full.trim().length > 0,
          messageId: persistedId,
        });
        controller.close();
      } finally {
        request.signal.removeEventListener("abort", onAbort);
      }
    },
  });
 
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Conversation-Id": conversationId,
      "X-User-Message-Id": userMessageId,
    },
  });
}
 