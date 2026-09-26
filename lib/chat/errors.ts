export type ChatErrorCode =
  | "unauthenticated"
  | "invalid_request"
  | "not_found"
  | "forbidden"
  | "config_error"
  | "rate_limited"
  /** Phase 6 correction: the rate-limit infrastructure itself (DB/RPC) failed — distinct from 429, which means the limit was actually reached. Fails closed rather than silently allowing unlimited requests. */
  | "rate_limit_unavailable"
  | "provider_error"
  | "network_error"
  | "database_error"
  /** An attached document can't be used yet (still processing, or processing failed). */
  | "document_error"
  | "unknown";

export class ChatError extends Error {
  code: ChatErrorCode;
  /** HTTP status to respond with. */
  status: number;

  constructor(code: ChatErrorCode, message: string, status: number) {
    super(message);
    this.name = "ChatError";
    this.code = code;
    this.status = status;
  }
}

const STATUS_BY_CODE: Record<ChatErrorCode, number> = {
  unauthenticated: 401,
  invalid_request: 400,
  not_found: 404,
  forbidden: 403,
  config_error: 500,
  rate_limited: 429,
  rate_limit_unavailable: 503,
  provider_error: 502,
  network_error: 502,
  database_error: 500,
  document_error: 409,
  unknown: 500,
};

export function chatError(code: ChatErrorCode, message: string): ChatError {
  return new ChatError(code, message, STATUS_BY_CODE[code]);
}

/**
 * Maps an arbitrary thrown value (from the Gemini SDK, fetch, Supabase,
 * or anywhere else) to a safe, user-facing ChatError. Never forwards the
 * original message verbatim — provider payloads, stack traces, and raw
 * database errors must never reach the client.
 */
export function mapUnknownError(error: unknown): ChatError {
  if (error instanceof ChatError) return error;

  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (message.includes("429") || message.includes("rate limit") || message.includes("quota")) {
    return chatError(
      "rate_limited",
      "The AI provider is temporarily rate-limited. Please wait a moment and try again."
    );
  }

  if (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("timeout")
  ) {
    return chatError(
      "network_error",
      "We couldn't reach the AI provider. Check your connection and try again."
    );
  }

  if (message.includes("api key") || message.includes("permission") || message.includes("401")) {
    return chatError(
      "config_error",
      "The AI provider isn't configured correctly. Please contact the site administrator."
    );
  }

  return chatError("provider_error", "The assistant couldn't generate a response. Please try again.");
}
