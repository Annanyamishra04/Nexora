import { createClient } from "@/lib/supabase/server";
import { documentError, DocumentExtractionError } from "@/lib/documents/errors";
import { processDocumentEmbeddings } from "@/lib/rag/pipeline";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(error: DocumentExtractionError) {
  return Response.json({ error: error.message }, { status: error.status });
}

/**
 * Retries chunking + embedding for a document whose original text was
 * already extracted and stored (documents.extracted_text) but whose
 * embedding step never completed successfully — a genuine provider
 * failure, or a Phase 3 document backfilled to 'processing' by migration
 * 0005 (see its comments). Re-extraction from the original file is not
 * needed or attempted here: only the embedding step is retried, exactly
 * per "Reprocessing / retry" in the phase brief.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return errorResponse(documentError("unauthenticated", "You must be signed in."));
  }

  // Reprocessing re-runs the same embedding work as a fresh upload, so it
  // shares the upload budget rather than getting its own — otherwise
  // repeated reprocess calls would be an easy way around the upload limit.
  const rateLimit = await checkRateLimit(supabase, "document_upload");
  if (!rateLimit.ok) {
    return errorResponse(
      documentError(
        "rate_limit_unavailable",
        "Request protection is temporarily unavailable. Please try again in a moment."
      )
    );
  }
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "You've made too many document requests recently. Please try again later.", code: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
    );
  }

  // Ownership is derived from the authenticated session and enforced by
  // RLS on the select itself — the client only ever supplies the ID, and
  // a document belonging to someone else simply doesn't come back here.
  const { data: document } = await supabase
    .from("documents")
    .select("id, filename, mime_type, extracted_text")
    .eq("id", id)
    .single();

  if (!document) {
    return errorResponse(documentError("not_found", "Document not found."));
  }

  const result = await processDocumentEmbeddings(supabase, {
    documentId: document.id,
    userId: user.id,
    text: document.extracted_text,
    filename: document.filename,
    contentType: document.mime_type,
  });

  const { data: updated } = await supabase
    .from("documents")
    .select(
      "id, filename, mime_type, size_bytes, extraction_status, chunk_count, processing_error, created_at"
    )
    .eq("id", document.id)
    .single();

  if (!updated) {
    return errorResponse(documentError("database_error", "Reprocessing finished but the document couldn't be reloaded."));
  }

  return Response.json({ document: updated, ok: result.ok });
}
