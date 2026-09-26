import type { Metadata } from "next";
import Link from "next/link";
import { MessageSquare, FolderOpen, SquarePen } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";

export const metadata: Metadata = { title: "Overview — Nexora" };

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { count: conversationCount } = await supabase
    .from("conversations")
    .select("id", { count: "exact", head: true });

  const displayName = user?.email?.split("@")[0] ?? "there";

  return (
    <div>
      <PageHeader
        title={`Welcome, ${displayName}`}
        description="Here's a quick look at your workspace."
      />

      <div className="grid gap-4 p-6 sm:grid-cols-2 lg:p-10">
        <div className="card-surface p-5">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-moss-50 text-moss-600">
              <MessageSquare size={15} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span className="text-sm text-ink-muted">Conversations</span>
          </div>
          <p className="mb-4 text-3xl font-serif text-ink">{conversationCount ?? 0}</p>
          <Link
            href="/chat"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-moss-600 transition-colors hover:text-moss-700"
          >
            <SquarePen size={14} strokeWidth={1.75} aria-hidden="true" />
            Start a new conversation
          </Link>
        </div>

        <div className="card-surface p-5">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-clay-50 text-clay-500">
              <FolderOpen size={15} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span className="text-sm text-ink-muted">Files</span>
          </div>
          <p className="mb-4 text-3xl font-serif text-ink">—</p>
          <Link
            href="/files"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-moss-600 transition-colors hover:text-moss-700"
          >
            <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
            Go to files
          </Link>
        </div>
      </div>

      <div className="px-6 pb-10 lg:px-10">
        <div className="card-surface flex flex-wrap items-center justify-between gap-4 p-5">
          <div>
            <h2 className="text-base font-medium text-ink">Signed in as</h2>
            <p className="text-sm text-ink-muted">{user?.email}</p>
          </div>
          <Link
            href="/settings"
            className="inline-flex h-10 items-center justify-center rounded-md border border-line px-4 text-sm font-medium text-ink transition-colors hover:border-line-strong hover:bg-paper"
          >
            Manage account
          </Link>
        </div>
      </div>
    </div>
  );
}
