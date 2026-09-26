import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Chat } from "@/components/chat/chat";
import type { ChatMessage } from "@/components/chat/message-bubble";
import type { ComposerDocument } from "@/components/chat/composer";
import type { MessageMetadata } from "@/lib/supabase/types";

export const metadata: Metadata = { title: "Chat — Nexora" };

const MAX_LOADED_MESSAGES = 200;

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ c?: string; doc?: string }>;
}) {
  const { c: conversationId, doc: initialDocumentId } = await searchParams;

  const supabase = await createClient();

  let initialMessages: ChatMessage[] = [];
  let truncatedHistory = false;

  if (conversationId) {
    // RLS already scopes this to the current user, but we still branch
    // explicitly on "not found" rather than assuming the row exists —
    // a stale link or someone else's conversation ID must never render.
    const { data: conversation } = await supabase
      .from("conversations")
      .select("id")
      .eq("id", conversationId)
      .single();

    if (!conversation) {
      notFound();
    }

    // Bounded load: the most recent MAX_LOADED_MESSAGES only (newest
    // first, then reversed), so a very long conversation can't make this
    // page arbitrarily heavy. One extra row tells us whether more exist.
    const { data: newestFirst } = await supabase
      .from("messages")
      .select("id, role, content, status, metadata")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(MAX_LOADED_MESSAGES + 1);

    truncatedHistory = (newestFirst?.length ?? 0) > MAX_LOADED_MESSAGES;
    const rows = (newestFirst ?? []).slice(0, MAX_LOADED_MESSAGES).reverse();

    initialMessages = rows
      .filter((row) => row.role === "user" || row.role === "assistant")
      .map((row) => {
        const metadata = row.metadata as MessageMetadata | null;
        return {
          id: row.id,
          role: row.role as "user" | "assistant",
          content: row.content,
          status: row.status,
          attachedFilename: metadata && "filename" in metadata ? metadata.filename : null,
          sources: metadata && "sources" in metadata ? metadata.sources : undefined,
        };
      });
  }

  // Only the filename/id are needed for the attach picker — never the
  // extracted text, which stays server-side until a message is actually
  // sent. Scoped to 'ready' documents only: attaching one that's still
  // processing or failed isn't retrievable yet (see
  // app/api/chat/route.ts), so it isn't offered as an option here.
  const { data: documentRows } = await supabase
    .from("documents")
    .select("id, filename")
    .eq("extraction_status", "ready")
    .order("created_at", { ascending: false });

  const documents: ComposerDocument[] = (documentRows ?? []).map((d) => ({
    id: d.id,
    filename: d.filename,
  }));

  return (
    <Chat
      key={conversationId ?? "new"}
      initialConversationId={conversationId ?? null}
      initialMessages={initialMessages}
      truncatedHistory={truncatedHistory}
      documents={documents}
      initialDocumentId={!conversationId ? (initialDocumentId ?? null) : null}
    />
  );
}
