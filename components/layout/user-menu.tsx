"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronUp, LogOut, Settings } from "lucide-react";
import Link from "next/link";
import { logout } from "@/app/(auth)/actions";
import { cn } from "@/lib/utils";

export function UserMenu({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const initial = email.charAt(0).toUpperCase();

  return (
    <div
      ref={ref}
      className="relative"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
    >
      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 mb-2 w-full min-w-[200px] animate-scale-in rounded-md border border-line bg-paper-overlay py-1 shadow-elevated"
        >
          <Link
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2 text-sm text-ink hover:bg-paper"
          >
            <Settings size={15} strokeWidth={1.75} aria-hidden="true" />
            Settings
          </Link>
          <form action={logout}>
            <button
              type="submit"
              role="menuitem"
              className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm text-danger-500 hover:bg-paper"
            >
              <LogOut size={15} strokeWidth={1.75} aria-hidden="true" />
              Sign out
            </button>
          </form>
        </div>
      )}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Account menu for ${email}`}
        className={cn(
          "flex w-full items-center gap-2.5 rounded px-2 py-2 text-left transition-colors hover:bg-paper-raised",
          open && "bg-paper-raised"
        )}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-moss-500 text-xs font-medium text-on-accent">
          {initial}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-ink">{email}</span>
        <ChevronUp
          size={14}
          strokeWidth={2}
          aria-hidden="true"
          className={cn("shrink-0 text-ink-faint transition-transform", !open && "rotate-180")}
        />
      </button>
    </div>
  );
}
