import { createClient } from "@/lib/supabase/server";
import { documentError, DocumentExtractionError } from "@/lib/documents/errors";
import { tryDeleteOriginalFile } from "@/lib/documents/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function errorResponse(error: DocumentExtractionError) {
  return Response.json({ error: error.message }, { status: error.status });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return errorResponse(documentError("unauthenticated", "You must be signed in."));
  }

  // Ownership is derived from the authenticated session and re-checked by
  // RLS on the delete itself — the client only ever supplies the ID.
  const { data: document } = await supabase
    .from("documents")
    .select("id, storage_path")
    .eq("id", id)
    .single();

  if (!document) {
    return errorResponse(documentError("not_found", "Document not found."));
  }

  const { error: deleteError } = await supabase.from("documents").delete().eq("id", document.id);

  if (deleteError) {
    return errorResponse(documentError("database_error", "Couldn't delete this document."));
  }

  const storageResult = await tryDeleteOriginalFile(supabase, document.storage_path);

  // The database record — the part that actually gates access to the
  // document's content and its use in chat — is gone at this point. A
  // failed storage cleanup is reported rather than hidden, but it does
  // not undo the deletion (there's nothing meaningful to roll back to).
  if (storageResult.attempted && !storageResult.ok) {
    return Response.json(
      {
        deleted: true,
        warning: "The document was deleted, but its original file couldn't be removed from storage.",
      },
      { status: 200 }
    );
  }

  return Response.json({ deleted: true });
}
