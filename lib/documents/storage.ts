import type { SupabaseClient } from "@supabase/supabase-js";

export const DOCUMENTS_BUCKET = "documents";

/**
 * Storage paths are always generated server-side from the authenticated
 * user's ID and the document's own (generated) UUID — never from the
 * raw, attacker-controlled filename — so there is no path-traversal
 * surface and RLS's `(storage.foldername(name))[1] = auth.uid()` check
 * (see migration 0004) always holds. The original filename is kept only
 * as the last path segment, sanitized, purely for human readability if
 * someone inspects the bucket directly.
 */
export function buildStoragePath(userId: string, documentId: string, filename: string): string {
  const safeName =
    filename
      .replace(/[/\\]/g, "_")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(-100) || "file";

  return `${userId}/${documentId}/${safeName}`;
}

/**
 * Uploads the original file to private storage. This is best-effort and
 * deliberately non-fatal: the app's actual dependency is the extracted
 * text already saved in `documents.extracted_text`, so a storage hiccup
 * shouldn't fail the whole upload. Returns null (not the path) on
 * failure, which the caller stores as `storage_path: null` — see
 * docs/ARCHITECTURE.md "Storage decision".
 */
export async function tryUploadOriginalFile(
  supabase: SupabaseClient,
  path: string,
  buffer: Buffer,
  mimeType: string
): Promise<string | null> {
  try {
    const { error } = await supabase.storage.from(DOCUMENTS_BUCKET).upload(path, buffer, {
      contentType: mimeType,
      upsert: false,
    });
    if (error) {
      console.error("Document storage upload failed:", error.message);
      return null;
    }
    return path;
  } catch (error) {
    console.error("Document storage upload threw:", error);
    return null;
  }
}

/**
 * Best-effort delete. Returns whether the storage object was removed so
 * the caller can decide how to report a partial failure — see the
 * DELETE route for how this is surfaced rather than silently ignored.
 */
export async function tryDeleteOriginalFile(
  supabase: SupabaseClient,
  path: string | null
): Promise<{ attempted: boolean; ok: boolean }> {
  if (!path) return { attempted: false, ok: true };
  try {
    const { error } = await supabase.storage.from(DOCUMENTS_BUCKET).remove([path]);
    return { attempted: true, ok: !error };
  } catch {
    return { attempted: true, ok: false };
  }
}
