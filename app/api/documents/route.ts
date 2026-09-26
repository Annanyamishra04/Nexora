import { createClient } from "@/lib/supabase/server";
import { documentError, mapDocumentError, DocumentExtractionError } from "@/lib/documents/errors";
import { validateUploadBasics, verifyFileSignature, type SupportedExtension } from "@/lib/documents/validate";
import { extractDocumentText } from "@/lib/documents/extract-text";
import { persistUploadedDocument } from "@/lib/documents/upload-flow";
import { processDocumentEmbeddings } from "@/lib/rag/pipeline";
import { checkRateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(error: DocumentExtractionError) {
  return Response.json({ error: error.message }, { status: error.status });
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return errorResponse(documentError("unauthenticated", "You must be signed in."));
  }

  const { data, error } = await supabase
    .from("documents")
    .select(
      "id, filename, mime_type, size_bytes, extraction_status, chunk_count, processing_error, created_at"
    )
    .order("created_at", { ascending: false });

  if (error) {
    return errorResponse(documentError("database_error", "Couldn't load your documents."));
  }

  return Response.json({ documents: data ?? [] });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return errorResponse(documentError("unauthenticated", "You must be signed in."));
  }

  // Checked before reading the upload body at all — an over-limit caller
  // shouldn't cost us a multipart parse, let alone extraction/embedding.
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
      { error: "You've uploaded too many documents recently. Please try again later.", code: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rateLimit.retryAfterSeconds) } }
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(documentError("invalid_request", "Expected a multipart file upload."));
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return errorResponse(documentError("invalid_request", "No file was provided."));
  }

  try {
    // 1. Cheap checks first (name, claimed MIME, size) before reading the
    // whole file into memory.
    const { extension } = validateUploadBasics({
      filename: file.name,
      mimeType: file.type,
      size: file.size,
    });

    const buffer = Buffer.from(await file.arrayBuffer());

    // 2. Confirm the bytes actually match the claimed type.
    verifyFileSignature(buffer, extension as SupportedExtension);

    // 3. Extract and normalize text server-side. Throws (with a safe
    // message) for corrupted/password-protected/empty documents.
    const extracted = await extractDocumentText(buffer, extension as SupportedExtension);

    // 4. Generate the document ID first, upload the original file to
    // Storage under that ID, then insert the row already carrying the
    // resulting storage_path — no UPDATE (and so no documents UPDATE
    // RLS policy) required. See lib/documents/upload-flow.ts.
    const document = await persistUploadedDocument(supabase, {
      userId: user.id,
      filename: file.name,
      mimeType: file.type || `application/${extension}`,
      sizeBytes: file.size,
      buffer,
      extractedText: extracted.text,
    });

    // 5. Chunk + embed + store immediately, in the same request (no
    // background workers in this deployment — see
    // docs/ARCHITECTURE.md "Deployment strategy"). Never throws: it
    // always leaves the document 'ready' or 'failed' with a safe message,
    // which is exactly what's echoed back to the client below.
    const result = await processDocumentEmbeddings(supabase, {
      documentId: document.id,
      userId: user.id,
      text: extracted.text,
      filename: document.filename,
      contentType: document.mime_type,
    });

    return Response.json(
      {
        document: {
          ...document,
          extraction_status: result.ok ? "ready" : "failed",
          chunk_count: result.chunkCount,
          processing_error: result.ok ? null : result.error,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    return errorResponse(error instanceof DocumentExtractionError ? error : mapDocumentError(error));
  }
}
