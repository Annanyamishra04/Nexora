export type DocumentErrorCode =
  | "unauthenticated"
  | "invalid_request"
  | "unsupported_type"
  | "too_large"
  | "empty_content"
  | "extraction_failed"
  | "not_found"
  | "storage_error"
  | "database_error"
  /** Phase 4: chunking succeeded but embedding generation/storage failed — see lib/rag/pipeline.ts. */
  | "embedding_failed"
  /** Phase 6: caller has exceeded a configured rate limit — see lib/rate-limit.ts. */
  | "rate_limited"
  /** Phase 6 correction: the rate-limit infrastructure itself (DB/RPC) failed — distinct from 429. Fails closed. */
  | "rate_limit_unavailable";

const STATUS_BY_CODE: Record<DocumentErrorCode, number> = {
  unauthenticated: 401,
  invalid_request: 400,
  unsupported_type: 415,
  too_large: 413,
  empty_content: 422,
  extraction_failed: 422,
  not_found: 404,
  storage_error: 500,
  database_error: 500,
  embedding_failed: 502,
  rate_limited: 429,
  rate_limit_unavailable: 503,
};

/**
 * A safe, user-facing error for anything in the upload/extraction path.
 * The `message` is always safe to show directly — parser internals,
 * stack traces, and file paths must never end up here.
 */
export class DocumentExtractionError extends Error {
  code: DocumentErrorCode;
  status: number;

  constructor(code: DocumentErrorCode, message: string) {
    super(message);
    this.name = "DocumentExtractionError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
  }
}

export function documentError(code: DocumentErrorCode, message: string): DocumentExtractionError {
  return new DocumentExtractionError(code, message);
}

/**
 * Maps an arbitrary thrown value (from unpdf, mammoth, Supabase, or
 * anywhere else in the upload path) to a safe DocumentExtractionError.
 * Parser stack traces and internal messages never reach the client.
 */
export function mapDocumentError(error: unknown): DocumentExtractionError {
  if (error instanceof DocumentExtractionError) return error;

  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (message.includes("password") || message.includes("encrypted")) {
    return documentError(
      "extraction_failed",
      "This PDF is password-protected. Remove the password and try again."
    );
  }

  return documentError(
    "extraction_failed",
    "We couldn't read this file. It may be corrupted or in an unexpected format."
  );
}
