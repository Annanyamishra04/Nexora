"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

/**
 * Accessible confirmation dialog built on the native <dialog> element.
 * showModal() gives us, for free and correctly: a focus trap, inert
 * background, top-layer stacking, Escape-to-close, and aria-modal
 * semantics — without adding a library.
 *
 * Focus starts on Cancel (the safe choice) and returns to whatever
 * opened the dialog when it closes.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Delete",
  pending = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opener.current = document.activeElement;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      aria-describedby="confirm-desc"
      // Escape fires "cancel"; route it through our handler so state stays in sync.
      onCancel={(event) => {
        event.preventDefault();
        if (!pending) onCancel();
      }}
      onClose={() => {
        if (opener.current instanceof HTMLElement) opener.current.focus();
      }}
      onClick={(event) => {
        // Backdrop click (the dialog element itself, not its content).
        if (event.target === ref.current && !pending) onCancel();
      }}
      className="w-[calc(100%-2rem)] max-w-sm rounded-lg border border-line bg-paper-overlay p-0 text-ink shadow-elevated backdrop:bg-ink/40"
    >
      <div className="animate-scale-in p-5">
        <h2 id="confirm-title" className="text-base font-medium">
          {title}
        </h2>
        <p id="confirm-desc" className="mt-2 text-sm text-ink-muted">
          {description}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={pending} autoFocus>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={onConfirm}
            disabled={pending}
            className="bg-danger-500 hover:bg-danger-500/90 active:bg-danger-500"
          >
            {pending ? "Deleting…" : confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
