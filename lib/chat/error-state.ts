/**
 * Turns the many ways a chat request can fail into one of a handful of
 * user-facing categories, each with a safe default message and a
 * "does retrying make sense?" flag.
 *
 * Server messages are already safe by construction (lib/chat/errors.ts
 * never forwards provider payloads or stack traces), so they're shown
 * as-is. But anything thrown *client-side* — "Failed to fetch",
 * "Unexpected token < in JSON" — is never displayed verbatim; those are
 * mapped to a category default instead.
 */

export type ChatErrorKind =
  | "auth"
  | "network"
  | "provider"
  | "rate_limit"
  | "retrieval"
  | "document"
  | "validation"
  | "not_found"
  | "unknown";

export interface ErrorPresentation {
  kind: ChatErrorKind;
  /** Short label, e.g. for a banner heading or an aria-label. */
  title: string;
  message: string;
  /** Whether trying the same action again could plausibly succeed. */
  retryable: boolean;
}

const DEFAULTS: Record<ChatErrorKind, { title: string; message: string; retryable: boolean }> = {
  auth: {
    title: "Signed out",
    message: "Your session has expired. Sign in again to continue.",
    retryable: false,
  },
  network: {
    title: "Connection problem",
    message: "Couldn't reach Nexora. Check your connection and try again.",
    retryable: true,
  },
  provider: {
    title: "Assistant unavailable",
    message: "The assistant couldn't generate a response. Please try again.",
    retryable: true,
  },
  rate_limit: {
    title: "Rate limited",
    message: "The AI provider is temporarily rate-limited. Please wait a moment and try again.",
    retryable: true,
  },
  retrieval: {
    title: "Documents unavailable",
    message: "Couldn't search your documents for this reply, so it may not be grounded in them.",
    retryable: true,
  },
  document: {
    title: "Document not ready",
    message: "That document can't be used yet.",
    retryable: false,
  },
  validation: {
    title: "Invalid request",
    message: "That request wasn't valid.",
    retryable: false,
  },
  not_found: {
    title: "Not found",
    message: "That conversation or message no longer exists.",
    retryable: false,
  },
  unknown: {
    title: "Something went wrong",
    message: "Something went wrong on our side. Please try again.",
    retryable: true,
  },
};

/** Maps a server ChatErrorCode (see lib/chat/errors.ts) to a category. */
export function kindFromCode(code: string | undefined): ChatErrorKind | null {
  switch (code) {
    case "unauthenticated":
      return "auth";
    case "invalid_request":
      return "validation";
    case "not_found":
    case "forbidden":
      return "not_found";
    case "rate_limited":
      return "rate_limit";
    // "network_error" from the server means *it* couldn't reach the AI
    // provider — that's a provider problem from the person's point of
    // view, not a problem with their own connection.
    case "provider_error":
    case "network_error":
    case "config_error":
      return "provider";
    case "document_error":
      return "document";
    case "database_error":
    case "unknown":
      return "unknown";
    default:
      return null;
  }
}

/** Fallback when a response carries no recognizable `code`. */
export function kindFromStatus(status: number | undefined): ChatErrorKind {
  if (status === 401) return "auth";
  if (status === 403 || status === 404) return "not_found";
  if (status === 429) return "rate_limit";
  if (status === 400 || status === 413 || status === 422) return "validation";
  if (status !== undefined && status >= 500) return "unknown";
  return "unknown";
}

/** Thrown by the client when /api/chat (or another endpoint) answers with a non-2xx JSON error. */
export class ChatRequestError extends Error {
  code?: string;
  status?: number;
  constructor(message: string, options: { code?: string; status?: number } = {}) {
    super(message);
    this.name = "ChatRequestError";
    this.code = options.code;
    this.status = options.status;
  }
}

export interface ErrorInput {
  code?: string;
  status?: number;
  /** Only trusted when it came from our own server (a ChatRequestError / stream error event). */
  serverMessage?: string;
  /** A failure raised by the browser itself (fetch rejected, stream read failed). */
  clientNetworkFailure?: boolean;
}

export function presentError(input: ErrorInput): ErrorPresentation {
  const kind: ChatErrorKind = input.clientNetworkFailure
    ? "network"
    : (kindFromCode(input.code) ?? kindFromStatus(input.status));

  const defaults = DEFAULTS[kind];
  return {
    kind,
    title: defaults.title,
    message: input.serverMessage?.trim() || defaults.message,
    retryable: defaults.retryable,
  };
}

/**
 * Classifies an arbitrary thrown value from the browser side of a chat
 * request. Only ChatRequestError text is trusted; everything else
 * (TypeError from fetch, JSON parse errors, …) becomes a category default.
 */
export function presentThrown(error: unknown): ErrorPresentation {
  if (error instanceof ChatRequestError) {
    return presentError({ code: error.code, status: error.status, serverMessage: error.message });
  }
  // fetch() rejects with a TypeError for offline / DNS / CORS / dropped
  // connection. Anything else unexpected is reported generically.
  if (error instanceof TypeError) {
    return presentError({ clientNetworkFailure: true });
  }
  return presentError({});
}

/** Non-fatal warnings attached to a *successful* reply. */
export type ChatNotice = "retrieval_failed";

export function presentNotice(notice: ChatNotice): ErrorPresentation {
  switch (notice) {
    case "retrieval_failed":
      return { ...DEFAULTS.retrieval, kind: "retrieval" };
  }
}
