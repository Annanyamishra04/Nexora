import { createClient } from "@/lib/supabase/server";
import { errorResponse } from "@/lib/api/error-response";
import { chatError } from "@/lib/chat/errors";
import { conversationIdSchema, renameConversationSchema } from "@/lib/validation/conversation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Ownership model (same for PATCH and DELETE):
 *  - identity comes only from the session cookie, never from the request;
 *  - the write is filtered by BOTH the id and the session's user id, and
 *    RLS (conversations_update_own / conversations_delete_own) enforces it
 *    again in Postgres;
 *  - RLS reports another user's row as "0 rows affected", not an error, so
 *    "no row came back" is the not-found signal — identical for a missing
 *    id and someone else's id, so ids can't be probed.
 */

/** Rename. Body: { title }. Trimmed, whitespace-collapsed, 1–80 chars. */
export async function PATCH(request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return errorResponse(chatError("unauthenticated", "You must be signed in."));

  const { id } = await params;
  if (!conversationIdSchema.safeParse(id).success) {
    return errorResponse(chatError("not_found", "Conversation not found."));
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(chatError("invalid_request", "Request body must be valid JSON."));
  }

  const parsed = renameConversationSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(chatError("invalid_request", parsed.error.issues[0]?.message ?? "Invalid title."));
  }

  const { data, error } = await supabase
    .from("conversations")
    .update({ title: parsed.data.title })
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id, title, updated_at")
    .maybeSingle();

  if (error) return errorResponse(chatError("database_error", "Couldn't rename this conversation."));
  if (!data) return errorResponse(chatError("not_found", "Conversation not found."));

  return Response.json({ conversation: data });
}

/**
 * Delete. The conversation's messages and its conversation_documents links
 * are removed by ON DELETE CASCADE (migrations 0001/0004). The *documents*
 * themselves — and their chunks — are not touched: they belong to the user
 * and may be attached to other conversations.
 */
export async function DELETE(_request: Request, { params }: RouteContext) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return errorResponse(chatError("unauthenticated", "You must be signed in."));

  const { id } = await params;
  if (!conversationIdSchema.safeParse(id).success) {
    return errorResponse(chatError("not_found", "Conversation not found."));
  }

  const { data, error } = await supabase
    .from("conversations")
    .delete()
    .eq("id", id)
    .eq("user_id", user.id)
    .select("id");

  if (error) return errorResponse(chatError("database_error", "Couldn't delete this conversation."));
  if (!data || data.length === 0) {
    return errorResponse(chatError("not_found", "Conversation not found."));
  }

  return Response.json({ deleted: true });
}
