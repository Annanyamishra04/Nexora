/**
 * Client/server-shared shapes and helpers for conversation search
 * (supabase/migrations/0007_conversation_search.sql).
 */

export interface ConversationSearchResult {
  id: string;
  title: string;
  updatedAt: string;
  /** "title": the conversation's title matched. "message": a message inside it matched. */
  matchType: "title" | "message";
  /** Excerpt with matches wrapped in ⟦ ⟧ — only present for message matches. Render via parseSnippet(). */
  snippet: string | null;
}

export interface SearchRow {
  id: string;
  title: string;
  updated_at: string;
  match_type: "title" | "message";
  snippet: string | null;
}

export function toSearchResult(row: SearchRow): ConversationSearchResult {
  return {
    id: row.id,
    title: row.title,
    updatedAt: row.updated_at,
    matchType: row.match_type,
    snippet: row.snippet,
  };
}

export interface SnippetPart {
  text: string;
  highlighted: boolean;
}

const HIGHLIGHT_START = "⟦";
const HIGHLIGHT_END = "⟧";

/**
 * Splits a database-produced excerpt into plain/highlighted parts so the
 * UI can render matches with real <mark> React nodes. Deliberately not
 * HTML: message text is user/model-authored and must never be injected
 * as markup. Unbalanced markers degrade to plain text rather than throwing.
 */
export function parseSnippet(snippet: string | null | undefined): SnippetPart[] {
  if (!snippet) return [];
  const parts: SnippetPart[] = [];
  let rest = snippet;

  while (rest.length > 0) {
    const start = rest.indexOf(HIGHLIGHT_START);
    if (start === -1) {
      parts.push({ text: rest, highlighted: false });
      break;
    }
    const end = rest.indexOf(HIGHLIGHT_END, start + 1);
    if (end === -1) {
      parts.push({ text: rest.replace(HIGHLIGHT_START, ""), highlighted: false });
      break;
    }
    if (start > 0) parts.push({ text: rest.slice(0, start), highlighted: false });
    const matched = rest.slice(start + 1, end);
    if (matched) parts.push({ text: matched, highlighted: true });
    rest = rest.slice(end + 1);
  }

  return parts.filter((part) => part.text.length > 0);
}
