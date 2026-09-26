import type { Metadata } from "next";
import Link from "next/link";
import { SquarePen } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { ConversationList } from "@/components/conversations/conversation-list";

export const metadata: Metadata = { title: "Conversations — Nexora" };

const LIST_LIMIT = 50;

export default async function ConversationsPage() {
  const supabase = await createClient();
  const { data: conversations } = await supabase
    .from("conversations")
    .select("id, title, updated_at")
    .order("updated_at", { ascending: false })
    // Bounded: older conversations are reached via search rather than an unbounded list.
    .limit(LIST_LIMIT);

  return (
    <div>
      <PageHeader
        title="Conversations"
        description="Every thread you've started, most recent first."
        action={
          <Link
            href="/chat"
            className="inline-flex h-10 items-center justify-center gap-2 rounded bg-moss-500 px-4 text-sm font-medium text-on-accent transition-colors hover:bg-moss-600"
          >
            <SquarePen size={15} strokeWidth={1.75} aria-hidden="true" />
            New conversation
          </Link>
        }
      />

      <div className="p-4 sm:p-6 lg:p-10">
        <ConversationList
          initialConversations={(conversations ?? []).map((c) => ({ id: c.id, title: c.title, updatedAt: c.updated_at }))}
          limitReached={(conversations?.length ?? 0) >= LIST_LIMIT}
        />
      </div>
    </div>
  );
}
