"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, FileText, Pencil, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { getMessageActions, type MessageActionContext } from "@/lib/chat/message-actions";

const button =
  "inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded px-1.5 text-xs text-ink-muted transition-colors " +
  "hover:bg-paper-raised hover:text-ink disabled:cursor-not-allowed disabled:opacity-40 " +
  "[@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:min-w-10";

/**
 * Subtle per-message action row. Hidden until the message is hovered or
 * focused on devices with a mouse; always visible on touch devices (no
 * hover there). Buttons stay in the tab order even while visually hidden
 * and reveal the row on focus, so keyboard users never lose them.
 */
export function MessageActions({
  message,
  sourcesCount,
  sourcesOpen,
  onCopy,
  onEdit,
  onRegenerate,
  onToggleSources,
}: {
  message: MessageActionContext;
  sourcesCount: number;
  sourcesOpen: boolean;
  /** Returns whether the copy succeeded, so failure is never shown as success. */
  onCopy: () => Promise<boolean>;
  onEdit: () => void;
  onRegenerate: () => void;
  onToggleSources: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const actions = getMessageActions(message);
  if (actions.length === 0) return null;

  async function handleCopy() {
    const ok = await onCopy();
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      role="group"
      aria-label={message.role === "user" ? "Your message actions" : "Response actions"}
      className={cn(
        "mt-1 flex items-center gap-0.5 transition-opacity",
        "opacity-0 focus-within:opacity-100 group-hover/message:opacity-100",
        "[@media(hover:none)]:opacity-100",
        copied && "opacity-100"
      )}
    >
      {actions.map((action) => {
        switch (action.id) {
          case "copy":
            return (
              <button key="copy" type="button" onClick={handleCopy} className={button}
                aria-label={copied ? "Copied" : "Copy message"} title={copied ? "Copied" : "Copy"}>
                {copied ? <Check size={14} strokeWidth={2} aria-hidden="true" /> : <Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
                {copied && <span>Copied</span>}
              </button>
            );
          case "edit":
            return (
              <button key="edit" type="button" onClick={onEdit} disabled={action.disabled} className={button}
                aria-label="Edit message" title={action.disabled ? "Wait for the reply to finish" : "Edit and resend"}>
                <Pencil size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            );
          case "regenerate":
            return (
              <button key="regenerate" type="button" onClick={onRegenerate} disabled={action.disabled} className={button}
                aria-label="Regenerate response" title={action.disabled ? "Wait for the reply to finish" : "Regenerate"}>
                <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            );
          case "sources":
            return (
              <button key="sources" type="button" onClick={onToggleSources} className={button}
                aria-expanded={sourcesOpen} aria-label={`${sourcesOpen ? "Hide" : "Show"} sources (${sourcesCount})`}
                title={sourcesOpen ? "Hide sources" : "Show sources"}>
                <FileText size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>Sources ({sourcesCount})</span>
              </button>
            );
        }
      })}
      {/* Announces copy success to screen readers without moving focus. */}
      <span role="status" aria-live="polite" className="sr-only">{copied ? "Copied to clipboard" : ""}</span>
    </div>
  );
}
