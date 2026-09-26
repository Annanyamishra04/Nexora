import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildStoragePath, tryUploadOriginalFile, tryDeleteOriginalFile } from "@/lib/documents/storage";
import { documentError } from "@/lib/documents/errors";

export interface PersistDocumentInput {
  userId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  buffer: Buffer;
  extractedText: string;
}

export interface PersistedDocument {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  /**
   * Always "processing" at insert time. Text extraction happens before
   * this function runs, but chunking/embedding (lib/rag/pipeline.ts) is a
   * separate step the caller runs immediately afterward in the same
   * request — see app/api/documents/route.ts. The row only ever reaches
   * "ready" once that step has actually stored chunks.
   */
  extraction_status: "processing";
  created_at: string;
  storage_path: string | null;
}

/**
 * Fixes the original storage_path RLS gap: rather than inserting a row
 * and then UPDATE-ing it with the Storage path (which would need a
 * `documents` UPDATE policy we deliberately don't want), the document ID
 * is generated *before* anything is written, the Storage object is
 * uploaded under that ID first, and the row is inserted once — already
 * carrying the correct `storage_path` (or null, if the upload failed).
 *
 * If the Storage upload succeeds but the database insert then fails for
 * any reason, the uploaded object is removed so it doesn't become an
 * orphaned Storage object with no owning row.
 */
export async function persistUploadedDocument(
  supabase: SupabaseClient,
  input: PersistDocumentInput
): Promise<PersistedDocument> {
  const documentId = randomUUID();
  const storagePath = buildStoragePath(input.userId, documentId, input.filename);

  // Best-effort, as before — a Storage hiccup shouldn't block the
  // upload; the app's real dependency is extracted_text, not the
  // original file. See docs/ARCHITECTURE.md "Storage decision".
  const uploadedPath = await tryUploadOriginalFile(supabase, storagePath, input.buffer, input.mimeType);

  const { data: document, error: insertError } = await supabase
    .from("documents")
    .insert({
      id: documentId,
      user_id: input.userId,
      filename: input.filename,
      mime_type: input.mimeType,
      size_bytes: input.sizeBytes,
      storage_path: uploadedPath,
      extracted_text: input.extractedText,
      // Phase 4: extraction succeeding no longer means "ready" — the
      // document becomes retrievable only once lib/rag/pipeline.ts has
      // successfully chunked and embedded it (see documents_extraction_status_check
      // in supabase/migrations/0005_rag.sql).
      extraction_status: "processing",
    })
    .select("id, filename, mime_type, size_bytes, extraction_status, created_at, storage_path")
    .single();

  if (insertError || !document) {
    // The upload succeeded but the row it should belong to doesn't
    // exist — clean up rather than leave an orphaned Storage object.
    if (uploadedPath) {
      await tryDeleteOriginalFile(supabase, uploadedPath);
    }
    throw documentError("database_error", "Couldn't save the document.");
  }

  return document as PersistedDocument;
}
