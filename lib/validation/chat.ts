import { z } from "zod";

/**
 * A single chat turn from the client. Exactly one of four modes:
 *
 *  - new:        `content` (+ optional `conversationId`, `documentId`)
 *  - retry:      `retryMessageId` — regenerate a reply to an already-persisted
 *                user message that has no successful reply yet (Phase 2)
 *  - regenerate: `regenerateMessageId` — replace the *latest* assistant reply
 *                with a fresh one (Phase 5)
 *  - edit:       `editMessageId` + `content` — replace one of the caller's own
 *                user messages and everything after it, then answer the
 *                edited message (Phase 5)
 *
 * All modes except "new without a conversation" require `conversationId`,
 * and none of them ever accept a client-supplied user id — identity comes
 * from the session (see app/api/chat/route.ts).
 */
export const MAX_MESSAGE_LENGTH = 4000;

const uuid = z.string().uuid();

export const chatRequestSchema = z
  .object({
    conversationId: uuid.optional(),
    content: z
      .string()
      .trim()
      .min(1, "Message can't be empty")
      .max(MAX_MESSAGE_LENGTH, `Message can't exceed ${MAX_MESSAGE_LENGTH} characters`)
      .optional(),
    retryMessageId: uuid.optional(),
    regenerateMessageId: uuid.optional(),
    editMessageId: uuid.optional(),
    /** Attaches a previously-uploaded document to this turn — see lib/ai/document-prompt.ts. */
    documentId: uuid.optional(),
  })
  .superRefine((data, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });

    const targetIds = [data.retryMessageId, data.regenerateMessageId, data.editMessageId].filter(Boolean);

    if (targetIds.length > 1) {
      issue("Provide only one of retryMessageId, regenerateMessageId, or editMessageId");
      return;
    }

    if (data.editMessageId) {
      // Edit needs the replacement text.
      if (!data.content) issue("Editing a message requires new content");
    } else if (data.retryMessageId || data.regenerateMessageId) {
      // Retry/regenerate reuse persisted content; sending new content too is ambiguous.
      if (data.content) issue("Provide either content or retryMessageId, not both");
    } else if (!data.content) {
      issue("Provide either content or retryMessageId");
    }

    if (targetIds.length === 1 && !data.conversationId) {
      const field = data.retryMessageId
        ? "retryMessageId"
        : data.regenerateMessageId
          ? "regenerateMessageId"
          : "editMessageId";
      issue(`${field} requires conversationId`);
    }

    if (targetIds.length === 1 && data.documentId) {
      issue("documentId is derived automatically when retrying; don't send it explicitly");
    }
  });

export type ChatRequest = z.infer<typeof chatRequestSchema>;
