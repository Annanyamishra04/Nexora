import type { GeminiContent } from "@/lib/chat/context";

export interface StreamReplyParams {
  /** Server-side system instruction; never sent from or exposed to the client. */
  systemInstruction: string;
  /** Bounded conversation history, oldest first, ending with the new user turn. */
  history: GeminiContent[];
}

/**
 * A minimal contract any text-generation provider must satisfy. Chat
 * route code depends only on this interface, so a second provider can be
 * added later (e.g. as a fallback) without touching route logic —
 * see docs/ARCHITECTURE.md "AI provider abstraction".
 */
export interface AiProvider {
  /** Yields text chunks as they arrive. Throws on failure (see lib/chat/errors.ts for mapping). */
  streamReply(params: StreamReplyParams): AsyncIterable<string>;
}
