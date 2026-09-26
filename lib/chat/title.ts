const MAX_TITLE_LENGTH = 60;
const FALLBACK_TITLE = "New conversation";

/**
 * Derives a conversation title from the first user message without an
 * extra AI call. Collapses whitespace, truncates to a sentence-ish
 * length at a word boundary, and appends an ellipsis when truncated.
 */
export function deriveTitle(content: string): string {
  const collapsed = content.replace(/\s+/g, " ").trim();

  if (!collapsed) return FALLBACK_TITLE;
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed;

  const slice = collapsed.slice(0, MAX_TITLE_LENGTH);
  const lastSpace = slice.lastIndexOf(" ");
  const truncated = lastSpace > 20 ? slice.slice(0, lastSpace) : slice;

  return `${truncated.trimEnd()}…`;
}
