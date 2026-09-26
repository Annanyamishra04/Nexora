import Link from "next/link";
import { SquarePen } from "lucide-react";
import { NAV_ITEMS } from "@/components/layout/nav-items";
import { NavLink } from "@/components/layout/nav-link";
import { UserMenu } from "@/components/layout/user-menu";
import { ThemeToggle } from "@/components/layout/theme-toggle";

interface RecentConversation {
  id: string;
  title: string;
}

export function SidebarContent({
  email,
  recentConversations = [],
  onNavigate,
}: {
  email: string;
  recentConversations?: RecentConversation[];
  onNavigate?: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 pb-5 pt-6">
        <Link
          href="/dashboard"
          onClick={onNavigate}
          className="flex items-center gap-2.5 rounded-md transition-opacity hover:opacity-80"
        >
          <span className="brand-mark" aria-hidden="true" />
          <span className="flex flex-col leading-none">
            <span className="font-serif text-lg tracking-tight text-ink">Nexora</span>
            <span className="mt-0.5 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-faint">
              AI Knowledge Workspace
            </span>
          </span>
        </Link>
      </div>

      <div className="px-3 pb-4">
        <Link
          href="/chat"
          onClick={onNavigate}
          className="flex items-center justify-center gap-2 rounded-md bg-moss-500 px-3 py-2 text-sm font-medium text-on-accent shadow-subtle transition-colors hover:bg-moss-600"
        >
          <SquarePen size={15} strokeWidth={1.75} aria-hidden="true" />
          New conversation
        </Link>
      </div>

      <nav aria-label="Main" className="space-y-0.5 px-3">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.href} item={item} onNavigate={onNavigate} />
        ))}
      </nav>

      {recentConversations.length > 0 && (
        <div className="mt-5 flex-1 overflow-y-auto scrollbar-thin px-3">
          <p className="px-3 pb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-faint">
            Recent
          </p>
          <ul className="space-y-0.5">
            {recentConversations.map((conversation) => (
              <li key={conversation.id}>
                <Link
                  href={`/chat?c=${conversation.id}`}
                  onClick={onNavigate}
                  className="block truncate rounded-md px-3 py-1.5 text-sm text-ink-muted transition-colors hover:bg-paper hover:text-ink"
                  title={conversation.title}
                >
                  {conversation.title}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {recentConversations.length === 0 && <div className="flex-1" />}

      <div className="space-y-3 border-t border-line p-3">
        <div className="flex items-center justify-between px-1">
          <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-ink-faint">
            Appearance
          </span>
          <ThemeToggle compact />
        </div>
        <UserMenu email={email} />
      </div>
    </div>
  );
}
