"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";

export type ProfileActionState = {
  error: string | null;
  success: boolean;
};

const displayNameSchema = z
  .string()
  .trim()
  .max(80, "Keep it under 80 characters")
  .optional();

export async function updateDisplayName(
  _prevState: ProfileActionState,
  formData: FormData
): Promise<ProfileActionState> {
  const parsed = displayNameSchema.safeParse(formData.get("display_name") ?? "");

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid name", success: false };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You must be signed in.", success: false };
  }

  // RLS also enforces this, but checking here lets us return a clean
  // message instead of a raw database error.
  const { error } = await supabase
    .from("profiles")
    .update({ display_name: parsed.data || null })
    .eq("id", user.id);

  if (error) {
    return { error: "Couldn't save your changes. Please try again.", success: false };
  }

  revalidatePath("/settings");
  return { error: null, success: true };
}

// ---------------------------------------------------------------------------
// Data deletion (Phase 6)
//
// This deletes the user's conversations and documents — NOT the auth
// account itself. A true account deletion needs the Supabase service
// role (to call the admin API and remove the auth.users row), and this
// app deliberately never uses the service role anywhere (see
// docs/ARCHITECTURE.md and every RLS policy comment) — adding one now,
// just for this one action, would be a bigger architectural change than
// "production hardening" calls for and a bigger blast-radius mistake to
// get wrong. What's implemented here is safe to ship because it reuses
// exactly the same delete paths (and RLS) as the existing per-item
// delete buttons on the Conversations and Files pages — this just does
// it for everything at once, still scoped to `auth.uid()` throughout.
// ---------------------------------------------------------------------------

export type DeleteDataState = {
  error: string | null;
  success: boolean;
  /** How many of each were removed, for a confirmation message. */
  deletedConversations?: number;
  deletedDocuments?: number;
};

export async function deleteAllMyData(
  _prevState: DeleteDataState,
  formData: FormData
): Promise<DeleteDataState> {
  // Deliberately requires a typed confirmation phrase rather than just a
  // button click — this is destructive and, unlike a single
  // conversation/document delete, cannot be undone from within the app.
  const confirmation = formData.get("confirm");
  if (confirmation !== "DELETE") {
    return { error: 'Type "DELETE" to confirm.', success: false };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: "You must be signed in.", success: false };
  }

  // Conversations first: deleting a conversation cascades to its
  // messages and conversation_documents links (migrations 0001/0004),
  // but never to the documents themselves.
  const { data: deletedConversations, error: conversationsError } = await supabase
    .from("conversations")
    .delete()
    .eq("user_id", user.id)
    .select("id");

  if (conversationsError) {
    return { error: "Couldn't delete your conversations. Nothing else was changed.", success: false };
  }

  // Documents: fetch storage paths first so originals can be removed
  // from Storage too, then delete the rows (cascades document_chunks —
  // migration 0005).
  const { data: documents, error: documentsFetchError } = await supabase
    .from("documents")
    .select("id, storage_path")
    .eq("user_id", user.id);

  if (documentsFetchError) {
    return {
      error: "Your conversations were deleted, but documents could not be. Please try again.",
      success: false,
      deletedConversations: deletedConversations?.length ?? 0,
    };
  }

  const { data: deletedDocuments, error: documentsDeleteError } = await supabase
    .from("documents")
    .delete()
    .eq("user_id", user.id)
    .select("id");

  if (documentsDeleteError) {
    return {
      error: "Your conversations were deleted, but documents could not be. Please try again.",
      success: false,
      deletedConversations: deletedConversations?.length ?? 0,
    };
  }

  // Best-effort storage cleanup — same pattern as the single-document
  // DELETE route (lib/documents/storage.ts): a failure here is not
  // undone (the database rows, which gate access, are already gone) and
  // is logged rather than surfaced as a blocking error.
  const paths = (documents ?? []).map((d) => d.storage_path).filter((p): p is string => !!p);
  if (paths.length > 0) {
    const { error: storageError } = await supabase.storage.from("documents").remove(paths);
    if (storageError) {
      console.error(`Failed to remove ${paths.length} storage object(s) during data deletion:`, storageError.message);
    }
  }

  revalidatePath("/settings");
  revalidatePath("/conversations");
  revalidatePath("/files");

  return {
    error: null,
    success: true,
    deletedConversations: deletedConversations?.length ?? 0,
    deletedDocuments: deletedDocuments?.length ?? 0,
  };
}
