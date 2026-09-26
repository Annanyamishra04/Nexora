"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { SidebarContent } from "@/components/layout/sidebar-content";

interface RecentConversation {
  id: string;
  title: string;
}

export function AppShell({
  email,
  recentConversations = [],
  children,
}: {
  email: string;
  recentConversations?: RecentConversation[];
  children: React.ReactNode;
}) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const pathname = usePathname();
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Close the mobile drawer automatically on navigation.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  // Drawer behaves like a dialog: Escape closes it, focus moves in when it
  // opens and back to the menu button when it closes, page scroll is locked.
  useEffect(() => {
    if (!drawerOpen) return;
    const trigger = menuButtonRef.current;
    closeButtonRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setDrawerOpen(false);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      trigger?.focus();
    };
  }, [drawerOpen]);

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="hidden w-64 shrink-0 border-r border-line bg-paper-raised/70 lg:block">
        <SidebarContent email={email} recentConversations={recentConversations} />
      </aside>

      {/* Mobile top bar */}
      <div className="fixed inset-x-0 top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-paper-raised/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-paper-raised/80 lg:hidden">
        <span className="flex items-center gap-2">
          <span className="brand-mark" aria-hidden="true" />
          <span className="font-serif text-lg tracking-tight text-ink">Nexora</span>
        </span>
        <button
          ref={menuButtonRef}
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation menu"
          aria-expanded={drawerOpen}
          aria-haspopup="dialog"
          className="flex h-11 w-11 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-paper hover:text-ink"
        >
          <Menu size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            tabIndex={-1}
            aria-label="Close navigation menu"
            className="absolute inset-0 bg-ink/20 animate-fade-in"
            onClick={() => setDrawerOpen(false)}
          />
          {/* flex-col + min-h-0 child: the sidebar fills what's left *after* the close row, so the
              user menu at its bottom stays on screen (previously it was pushed below the fold). */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] animate-fade-in flex-col bg-paper-overlay shadow-elevated"
          >
            <div className="flex shrink-0 justify-end p-2">
              <button
                ref={closeButtonRef}
                type="button"
                onClick={() => setDrawerOpen(false)}
                aria-label="Close navigation menu"
                className="flex h-11 w-11 items-center justify-center rounded text-ink-muted hover:bg-paper hover:text-ink"
              >
                <X size={18} strokeWidth={1.75} aria-hidden="true" />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <SidebarContent
                email={email}
                recentConversations={recentConversations}
                onNavigate={() => setDrawerOpen(false)}
              />
            </div>
          </div>
        </div>
      )}

      <main className="min-w-0 flex-1 pt-14 lg:pt-0">{children}</main>
    </div>
  );
}
