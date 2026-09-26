import type { SourceRef } from "@/lib/supabase/types";
import type { ChatNotice } from "@/lib/chat/error-state";

/** NDJSON events emitted by app/api/chat/route.ts. */
export type StreamEvent =
  | { type: "chunk"; text: string }
  | { type: "done"; messageId: string; sources?: SourceRef[]; notice?: ChatNotice }
  | { type: "error"; message: string; code?: string; partial: boolean; messageId?: string };

/**
 * Parses one NDJSON line. Returns null for blank lines AND for anything
 * malformed or of an unknown shape — a single bad event must never crash
 * the reader or discard the text already received.
 */
export function parseStreamLine(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const event = raw as Record<string, unknown>;

  switch (event.type) {
    case "chunk":
      return typeof event.text === "string" ? { type: "chunk", text: event.text } : null;
    case "done":
      if (typeof event.messageId !== "string") return null;
      return {
        type: "done",
        messageId: event.messageId,
        sources: Array.isArray(event.sources) ? (event.sources as SourceRef[]) : undefined,
        notice: event.notice === "retrieval_failed" ? "retrieval_failed" : undefined,
      };
    case "error":
      return {
        type: "error",
        message: typeof event.message === "string" ? event.message : "The response was interrupted.",
        code: typeof event.code === "string" ? event.code : undefined,
        partial: event.partial === true,
        messageId: typeof event.messageId === "string" ? event.messageId : undefined,
      };
    default:
      return null;
  }
}

export interface StreamOutcome {
  /**
   * "done":        server sent a terminal `done` event.
   * "error":       server sent a terminal `error` event.
   * "interrupted": the stream ended (or the connection dropped) with NO
   *                terminal event — the response must not be treated as
   *                complete.
   */
  status: "done" | "error" | "interrupted";
  done?: Extract<StreamEvent, { type: "done" }>;
  error?: Extract<StreamEvent, { type: "error" }>;
  /** How many lines were skipped as malformed. */
  malformedCount: number;
  /** True if reading failed with a non-abort error (as opposed to a clean end-of-stream). */
  readFailed: boolean;
}

export interface ConsumeHandlers {
  onChunk: (text: string) => void;
  /** Called on every successful read — used by the caller's stall watchdog. */
  onActivity?: () => void;
}

/**
 * Reads an NDJSON chat stream to completion.
 *
 * Guarantees:
 *  - malformed lines are skipped and counted, never thrown;
 *  - a final line with no trailing newline is still processed;
 *  - a stream that ends without a terminal event is reported as
 *    "interrupted" rather than silently as complete;
 *  - a non-abort read failure is reported (readFailed) rather than thrown,
 *    so already-received text can be kept;
 *  - an AbortError (the person pressed Stop, navigated away, or the stall
 *    watchdog fired) IS rethrown so the caller can tell it apart.
 */
export async function consumeChatStream(
  body: ReadableStream<Uint8Array>,
  handlers: ConsumeHandlers
): Promise<StreamOutcome> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const outcome: StreamOutcome = { status: "interrupted", malformedCount: 0, readFailed: false };

  const handleLine = (line: string) => {
    if (!line.trim()) return;
    const event = parseStreamLine(line);
    if (!event) {
      outcome.malformedCount += 1;
      return;
    }
    if (event.type === "chunk") {
      if (event.text) handlers.onChunk(event.text);
    } else if (event.type === "done") {
      outcome.status = "done";
      outcome.done = event;
    } else {
      outcome.status = "error";
      outcome.error = event;
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      handlers.onActivity?.();
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    }
    buffer += decoder.decode();
    handleLine(buffer);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof Error && error.name === "AbortError") throw error;
    outcome.readFailed = true;
  }

  return outcome;
}
