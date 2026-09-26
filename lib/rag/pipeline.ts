import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChunkMetadata, Database } from "@/lib/supabase/types";
import { chunkText } from "@/lib/rag/chunk";
import { GeminiEmbeddingProvider, type EmbeddingProvider } from "@/lib/rag/embedding-provider";
import { mapEmbeddingError } from "@/lib/rag/errors";

export interface ProcessDocumentInput {
  documentId: string;
  userId: string;
  text: string;
  filename: string;
  contentType: string;
}

export interface ProcessDocumentResult {
  ok: boolean;
  chunkCount: number;
  /** Safe, user-facing message — only set when ok is false. */
  error?: string;
}

const defaultProvider = new GeminiEmbeddingProvider();

/**
 * The full embedding pipeline for one document (Phase 4 sections 3, 6, 8,
 * 9, 10, 27): chunk -> embed -> validate -> store -> mark ready, with a
 * safe, retryable failure path at every step. Runs synchronously within
 * the request that calls it (upload, or the reprocess endpoint) — there
 * are no background workers in this deployment (see docs/ARCHITECTURE.md
 * "Deployment strategy"), so "processing" is a real, if usually brief,
 * state the document sits in for the duration of this call.
 *
 * Always leaves the `documents` row in a consistent, non-misleading
 * state: 'ready' with chunk_count > 0, or 'failed' with chunk_count = 0
 * and a safe processing_error — never a partial mix of the two. Never
 * throws: callers (route handlers) inspect the returned result rather
 * than needing a try/catch around this call.
 */
export async function processDocumentEmbeddings(
  supabase: SupabaseClient<Database>,
  input: ProcessDocumentInput,
  provider: EmbeddingProvider = defaultProvider
): Promise<ProcessDocumentResult> {
  const { documentId, userId, text, filename, contentType } = input;

  // Idempotent by construction: delete-then-insert means retrying a
  // failed (or even a successful) run never duplicates chunks, and never
  // leaves last time's chunks mixed in with this time's — see "Failure /
  // cleanup strategy" and "Reprocessing / retry" in the phase brief.
  const { error: deleteError } = await supabase
    .from("document_chunks")
    .delete()
    .eq("document_id", documentId);
  if (deleteError) {
    return failDocument(supabase, documentId, "Couldn't clear previous chunks before processing.");
  }

  const chunks = chunkText(text);
  if (chunks.length === 0) {
    return failDocument(supabase, documentId, "No content could be chunked from this document.");
  }

  let embeddings: number[][];
  try {
    embeddings = await provider.embedTexts(
      chunks.map((chunk) => chunk.content),
      "RETRIEVAL_DOCUMENT"
    );
  } catch (error) {
    return failDocument(supabase, documentId, mapEmbeddingError(error).message);
  }

  if (embeddings.length !== chunks.length) {
    return failDocument(
      supabase,
      documentId,
      "The embedding provider returned an unexpected number of embeddings."
    );
  }

  const metadata: ChunkMetadata = { filename, contentType };
  const rows = chunks.map((chunk, i) => ({
    document_id: documentId,
    user_id: userId,
    chunk_index: chunk.index,
    content: chunk.content,
    embedding: embeddings[i]!,
    metadata,
  }));

  const { error: insertError } = await supabase.from("document_chunks").insert(rows);
  if (insertError) {
    // Don't leave a partially-inserted batch behind — a failed insert may
    // still have written some rows depending on where it failed.
    await supabase.from("document_chunks").delete().eq("document_id", documentId);
    return failDocument(supabase, documentId, "Couldn't store the generated embeddings.");
  }

  const { error: updateError } = await supabase
    .from("documents")
    .update({
      extraction_status: "ready",
      embedding_model: provider.model,
      embedding_dimensions: provider.dimensions,
      chunk_count: rows.length,
      processing_error: null,
    })
    .eq("id", documentId);

  if (updateError) {
    // The chunks themselves are valid and stored; only the status flip
    // failed. Treat this as a failure anyway — a document stuck showing
    // 'processing' forever with unrecognized, unused chunks is exactly
    // the "misleading partial state" this pipeline is meant to avoid. The
    // next reprocess attempt is a clean re-run (delete + re-insert), not
    // a race with stale chunks.
    return failDocument(
      supabase,
      documentId,
      "Embeddings were generated but the document status couldn't be updated."
    );
  }

  return { ok: true, chunkCount: rows.length };
}

async function failDocument(
  supabase: SupabaseClient<Database>,
  documentId: string,
  message: string
): Promise<ProcessDocumentResult> {
  await supabase
    .from("documents")
    .update({
      extraction_status: "failed",
      chunk_count: 0,
      processing_error: message,
    })
    .eq("id", documentId);
  return { ok: false, chunkCount: 0, error: message };
}
