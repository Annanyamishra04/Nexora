export interface HistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** Assistant messages cut off mid-generation are excluded from context sent to the model. */
  status?: "complete" | "incomplete";
}

export interface GeminiContent {
  role: "user" | "model";
  parts: { text: string }[];
}

/**
 * Phase 2 context-window strategy (documented in docs/ARCHITECTURE.md):
 *
 *  - At most MAX_MESSAGES most-recent messages are considered at all.
 *  - Within that window, we keep the most recent messages that fit under
 *    MAX_TOTAL_CHARACTERS, dropping the oldest first.
 *  - The newest message is never dropped, even if it alone is large
 *    (it's already bounded by MAX_MESSAGE_LENGTH at the validation layer).
 *  - `system` role rows (none exist yet, reserved for future use) are
 *    excluded — the system instruction is passed separately to the model.
 *
 * This is intentionally simple: no token counting, no summarization, no
 * RAG. It trades perfect accuracy for a predictable, cheap bound that
 * keeps free-tier usage sane.
 */
export const MAX_HISTORY_MESSAGES = 20;
export const MAX_HISTORY_CHARACTERS = 8000;

export function buildGeminiHistory(history: HistoryMessage[]): GeminiContent[] {
  const conversational = history.filter(
    (m): m is HistoryMessage & { role: "user" | "assistant" } =>
      (m.role === "user" || m.role === "assistant") && m.status !== "incomplete"
  );

  const windowed = conversational.slice(-MAX_HISTORY_MESSAGES);

  // Walk from newest to oldest, keeping messages until the character
  // budget is spent, then restore chronological order.
  const kept: HistoryMessage[] = [];
  let totalChars = 0;

  for (let i = windowed.length - 1; i >= 0; i--) {
    const message = windowed[i];
    if (!message) continue;
    const nextTotal = totalChars + message.content.length;
    if (kept.length > 0 && nextTotal > MAX_HISTORY_CHARACTERS) {
      break;
    }
    kept.unshift(message);
    totalChars = nextTotal;
  }

  return kept.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));
}
