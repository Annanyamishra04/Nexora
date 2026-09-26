import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { GeminiEmbeddingProvider, type EmbeddingProvider } from "@/lib/rag/embedding-provider";
import { mapEmbeddingError } from "@/lib/rag/errors";
import {
  RAG_MAX_CHARS_PER_CHUNK,
  RAG_MAX_CONTEXT_CHARS,
  RAG_SIMILARITY_THRESHOLD,
  RAG_TOP_K,
} from "@/lib/rag/config";

export interface RetrievableDocument {
  id: string;
  filename: string;
}

/**
 * The retrieval scope for a conversation (section 14/18 of the phase
 * brief): every document that has ever been attached to *this*
 * conversation (via conversation_documents) AND has successfully
 * finished embedding. A document still 'processing' or 'failed' is
 * excluded — it simply isn't retrievable yet, rather than silently
 * degrading to something else.
 *
 * Deliberately narrower than "everything the user owns": this is what
 * keeps an unrelated personal document out of the model's context for a
 * conversation that never referenced it.
 */
export async function getRetrievableDocuments(
  supabase: SupabaseClient<Database>,
  conversationId: string
): Promise<RetrievableDocument[]> {
  const { data: links } = await supabase
    .from("conversation_documents")
    .select("document_id")
    .eq("conversation_id", conversationId);

  const documentIds = (links ?? []).map((link) => link.document_id);
  if (documentIds.length === 0) return [];

  // RLS already scopes this to the caller's own documents; the explicit
  // extraction_status filter is what excludes not-yet-ready/failed docs.
  const { data: docs } = await supabase
    .from("documents")
    .select("id, filename")
    .eq("extraction_status", "ready")
    .in("id", documentIds);

  return docs ?? [];
}

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  content: string;
  similarity: number;
}

export interface RetrievalResult {
  /** True whenever retrieval was scoped to at least one ready document — even if it found nothing above threshold. */
  attempted: boolean;
  chunks: RetrievedChunk[];
}

const defaultProvider = new GeminiEmbeddingProvider();

/**
 * Embeds the query once (never the documents — those are embedded a
 * single time at upload/reprocess), runs pgvector similarity search via
 * the match_document_chunks RPC scoped to the given documents, applies
 * RAG_SIMILARITY_THRESHOLD, and returns chunks trimmed to a bounded total
 * character budget (RAG_MAX_CONTEXT_CHARS) — see "Context budget" and
 * "Embedding cost control" in the phase brief.
 */
export async function retrieveRelevantChunks(
  supabase: SupabaseClient<Database>,
  params: { documents: RetrievableDocument[]; query: string },
  provider: EmbeddingProvider = defaultProvider
): Promise<RetrievalResult> {
  const { documents, query } = params;
  if (documents.length === 0) {
    return { attempted: false, chunks: [] };
  }

  const filenameById = new Map(documents.map((d) => [d.id, d.filename]));

  let queryEmbedding: number[];
  try {
    queryEmbedding = await provider.embedText(query, "RETRIEVAL_QUERY");
  } catch (error) {
    // A failed query embedding must not crash the chat turn — it degrades
    // to "no retrieval happened", and the caller's prompt-building step
    // (lib/ai/rag-prompt.ts) is responsible for telling the model
    // plainly that no grounded context is available for this turn.
    throw mapEmbeddingError(error);
  }

  const { data, error } = await supabase.rpc("match_document_chunks", {
    query_embedding: queryEmbedding,
    match_count: RAG_TOP_K,
    filter_document_ids: documents.map((d) => d.id),
  });

  if (error || !data) {
    return { attempted: true, chunks: [] };
  }

  const aboveThreshold = data.filter((row) => row.similarity >= RAG_SIMILARITY_THRESHOLD);

  const chunks: RetrievedChunk[] = [];
  let budget = RAG_MAX_CONTEXT_CHARS;

  for (const row of aboveThreshold) {
    const filename = filenameById.get(row.document_id);
    // Defense in depth: a chunk whose document isn't in our own
    // documents map (i.e. wasn't part of the requested filter) is
    // dropped rather than trusted — see "Do not trust model-generated
    // citations" / ownership requirements. In normal operation this
    // never triggers, since match_document_chunks is already scoped to
    // `documents`.
    if (!filename) continue;

    const content = row.content.slice(0, RAG_MAX_CHARS_PER_CHUNK);
    if (content.length === 0) continue;
    // Always include at least one chunk even if it alone exceeds the
    // budget (better to answer from one oversized-but-relevant passage
    // than none at all); after that, stop rather than let the budget run
    // meaningfully negative.
    if (chunks.length > 0 && content.length > budget) break;

    chunks.push({
      chunkId: row.id,
      documentId: row.document_id,
      filename,
      chunkIndex: row.chunk_index,
      content,
      similarity: row.similarity,
    });
    budget -= content.length;
  }

  return { attempted: true, chunks };
}
