"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Paperclip, ArrowUp, Square, FileText, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { MAX_MESSAGE_LENGTH } from "@/lib/validation/chat";

export interface ComposerDocument {
  id: string;
  filename: string;
}

export function Composer({
  onSend,
  onStop,
  isStreaming = false,
  documents = [],
  attachedDocument,
  onAttach,
  onDetach,
  prefill,
}: {
  onSend: (text: string) => void;
  onStop?: () => void;
  isStreaming?: boolean;
  documents?: ComposerDocument[];
  attachedDocument?: ComposerDocument | null;
  onAttach?: (document: ComposerDocument) => void;
  onDetach?: () => void;
  /** Bump `nonce` to drop `text` into the box (e.g. from a suggested-prompt tile) without sending it. */
  prefill?: { text: string; nonce: number } | null;
}) {
  const [value, setValue] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overLimit = value.length > MAX_MESSAGE_LENGTH;

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Grow with the text (up to the max-h cap) instead of staying one line tall.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);

  // Return focus to the box once a reply finishes so the person can keep typing.
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !isStreaming) textareaRef.current?.focus();
    wasStreaming.current = isStreaming;
  }, [isStreaming]);

  // A suggested-prompt tile fills the box (cursor at the end) rather than sending immediately,
  // so the person can edit it first.
  const prefillNonce = useRef<number | null>(null);
  useEffect(() => {
    if (!prefill || prefill.nonce === prefillNonce.current) return;
    prefillNonce.current = prefill.nonce;
    setValue(prefill.text);
    const el = textareaRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
    }
  }, [prefill]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (isStreaming) return; // duplicate-submit guard
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_MESSAGE_LENGTH) return;
    onSend(trimmed);
    setValue("");
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-4 sm:pb-4"
    >
      {attachedDocument && (
        <div className="mb-2 flex w-fit items-center gap-2 rounded-md border border-moss-100 bg-moss-50 px-2.5 py-1.5 text-xs text-ink">
          <FileText size={13} strokeWidth={1.75} className="text-moss-600" aria-hidden="true" />
          <span className="max-w-[220px] truncate">Attached: {attachedDocument.filename}</span>
          <button
            type="button"
            onClick={onDetach}
            aria-label="Remove attached document"
            className="text-ink-faint hover:text-ink"
          >
            <X size={13} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      )}

      <div
        className={cn(
          "flex items-end gap-2 rounded-xl border border-line bg-paper-raised p-1.5 shadow-card transition-[border-color,box-shadow]",
          "focus-within:border-moss-500 focus-within:shadow-glow-accent"
        )}
      >
        <div
          ref={pickerRef}
          className="relative shrink-0"
          onKeyDown={(event) => {
            if (event.key === "Escape" && pickerOpen) {
              event.stopPropagation();
              setPickerOpen(false);
              pickerButtonRef.current?.focus();
            }
          }}
        >
          {pickerOpen && (
            <div className="absolute bottom-full left-0 mb-2 w-[min(16rem,calc(100vw-2rem))] animate-scale-in rounded-md border border-line bg-paper-overlay py-1 shadow-elevated">
              {documents.length === 0 ? (
                <div className="px-3 py-2 text-xs text-ink-faint">
                  No documents yet.{" "}
                  <a href="/files" className="underline underline-offset-2">
                    Upload one
                  </a>
                  .
                </div>
              ) : (
                <ul className="max-h-56 overflow-y-auto scrollbar-thin">
                  {documents.map((doc) => (
                    <li key={doc.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onAttach?.(doc);
                          setPickerOpen(false);
                        }}
                        className="flex w-full items-center gap-2 truncate px-3 py-1.5 text-left text-sm text-ink hover:bg-paper"
                        title={doc.filename}
                      >
                        <FileText size={13} strokeWidth={1.75} className="shrink-0 text-ink-faint" aria-hidden="true" />
                        <span className="truncate">{doc.filename}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <button
            ref={pickerButtonRef}
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            aria-label="Attach a document"
            aria-haspopup="true"
            aria-expanded={pickerOpen}
            title="Attach a document"
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-lg transition-colors sm:h-9 sm:w-9",
              attachedDocument
                ? "text-moss-600 hover:bg-moss-50"
                : "text-ink-muted hover:bg-paper hover:text-ink"
            )}
          >
            <Paperclip size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        <div className="min-w-0 flex-1">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                handleSubmit(event);
              }
            }}
            rows={1}
            disabled={isStreaming}
            placeholder={isStreaming ? "Waiting for a response…" : "Message Nexora…"}
            aria-label="Message"
            className="max-h-40 w-full resize-none bg-transparent py-2.5 text-base text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-60 sm:text-sm"
          />
          {overLimit && (
            <p role="alert" className="mt-1 text-xs text-danger-500">
              {value.length}/{MAX_MESSAGE_LENGTH} characters
            </p>
          )}
        </div>

        {isStreaming ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            title="Stop generating"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-ink text-paper-raised transition-colors hover:bg-ink/80 sm:h-9 sm:w-9"
          >
            <Square size={14} strokeWidth={2} fill="currentColor" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            disabled={!value.trim() || overLimit}
            aria-label="Send message"
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors sm:h-9 sm:w-9",
              value.trim() && !overLimit
                ? "bg-moss-500 text-on-accent hover:bg-moss-600"
                : "cursor-not-allowed bg-line text-ink-faint"
            )}
          >
            <ArrowUp size={18} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>
      <p className="mt-1.5 hidden px-1 text-center text-[11px] text-ink-faint sm:block">
        Nexora can make mistakes. Consider checking sources for important answers.
      </p>
    </form>
  );
}
