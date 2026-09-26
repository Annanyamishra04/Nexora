import { documentError, DocumentExtractionError } from "@/lib/documents/errors";

/**
 * Maps an arbitrary thrown value from the embedding provider (Gemini SDK)
 * or the chunk-storage step to a safe DocumentExtractionError. Mirrors
 * lib/documents/errors.ts's mapDocumentError, but scoped to the
 * embedding step so its messaging can be specific ("couldn't generate
 * embeddings" vs. "couldn't read this file") without conflating the two
 * very different failure points in the pipeline.
 */
export function mapEmbeddingError(error: unknown): DocumentExtractionError {
  if (error instanceof DocumentExtractionError) return error;

  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (message.includes("429") || message.includes("rate limit") || message.includes("quota")) {
    return documentError(
      "embedding_failed",
      "The embedding provider is temporarily rate-limited. You can retry processing this document in a moment."
    );
  }

  if (message.includes("api key") || message.includes("permission") || message.includes("401")) {
    return documentError(
      "embedding_failed",
      "The embedding provider isn't configured correctly. Please contact the site administrator."
    );
  }

  if (
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("econnreset") ||
    message.includes("enotfound") ||
    message.includes("timeout")
  ) {
    return documentError(
      "embedding_failed",
      "We couldn't reach the embedding provider. You can retry processing this document."
    );
  }

  return documentError(
    "embedding_failed",
    "We couldn't generate embeddings for this document. You can retry processing it."
  );
}
