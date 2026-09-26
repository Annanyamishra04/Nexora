import { z } from "zod";

export const MAX_CONVERSATION_TITLE_LENGTH = 80;
export const MIN_SEARCH_QUERY_LENGTH = 2;
export const MAX_SEARCH_QUERY_LENGTH = 100;

/**
 * Collapses any run of whitespace (including newlines/tabs) to a single
 * space and strips control characters, so a title is always one clean
 * line regardless of what was pasted in.
 */
export function normalizeTitle(raw: string): string {
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

const uuid = z.string().uuid();

export const conversationIdSchema = uuid;

/** PATCH /api/conversations/[id] */
export const renameConversationSchema = z.object({
  title: z
    .string({ required_error: "Title is required", invalid_type_error: "Title must be text" })
    .transform(normalizeTitle)
    .pipe(
      z
        .string()
        .min(1, "Title can't be empty")
        .max(
          MAX_CONVERSATION_TITLE_LENGTH,
          `Title can't exceed ${MAX_CONVERSATION_TITLE_LENGTH} characters`
        )
    ),
});

/** GET /api/conversations/search?q=… */
export const searchQuerySchema = z
  .string({ required_error: "Search text is required" })
  .transform((value) => value.replace(/\s+/g, " ").trim())
  .pipe(
    z
      .string()
      .min(MIN_SEARCH_QUERY_LENGTH, `Type at least ${MIN_SEARCH_QUERY_LENGTH} characters to search`)
      .max(MAX_SEARCH_QUERY_LENGTH, `Search can't exceed ${MAX_SEARCH_QUERY_LENGTH} characters`)
  );
