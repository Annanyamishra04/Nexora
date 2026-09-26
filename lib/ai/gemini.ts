import { GoogleGenAI } from "@google/genai";
import { chatError } from "@/lib/chat/errors";
import type { AiProvider, StreamReplyParams } from "@/lib/ai/provider";

/**
 * Model is configurable via env so it can be bumped without a code
 * change. Defaults to Google's "latest flash" alias, which Google
 * hot-swaps to the current stable Flash model — the closest thing to
 * "the current stable model" that doesn't need to be hand-updated every
 * time Google ships a new version. Pin an explicit version (e.g.
 * "gemini-2.5-flash") via GEMINI_MODEL if you need reproducibility.
 */
const DEFAULT_MODEL = "gemini-flash-latest";
/** Exported so the settings page can display the effective model without duplicating this default. */
export { DEFAULT_MODEL };

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Developer-actionable, but safe: never say anything Gemini-specific
    // that would help someone probe for the key's absence maliciously —
    // this message only ever reaches the server logs / our own error
    // mapping, never the client (see errors.ts).
    throw chatError(
      "config_error",
      "GEMINI_API_KEY is not set. Add it to your environment to enable AI responses."
    );
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

export class GeminiProvider implements AiProvider {
  async *streamReply({ systemInstruction, history }: StreamReplyParams): AsyncIterable<string> {
    const ai = getClient();
    const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;

    const stream = await ai.models.generateContentStream({
      model,
      contents: history,
      config: {
        systemInstruction,
        temperature: 0.7,
        maxOutputTokens: 2048,
      },
    });

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) yield text;
    }
  }
}
