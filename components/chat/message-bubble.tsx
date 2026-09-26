"use client";

import { memo, useEffect, useRef, useState } from "react";
import { AlertTriangle, FileText, ChevronDown, ChevronUp, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import { Markdown } from "@/components/chat/markdown";
import { MessageActions } from "@/components/chat/message-actions";
import { MAX_MESSAGE_LENGTH } from "@/lib/validation/chat";
import { presentNotice, type ChatNotice } from "@/lib/chat/error-state";
import type { SourceRef } from "@/lib/supabase/types";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** "streaming": still receiving chunks. "incomplete": generation was cut off. "complete": normal. */
  status: "complete" | "incomplete" | "streaming";
  /** Set when this user message was asked alongside an attached document. */
  attachedFilename?: string | null;
  /** Set when this assistant reply was grounded in retrieved document chunks — server-derived, see app/api/chat/route.ts. */
  sources?: SourceRef[];
  /** Non-fatal warning about how this reply was produced (e.g. document retrieval failed). Transient — not persisted. */
  notice?: ChatNotice;
}

/** Groups sources by document for display: "filename.pdf — chunks 2, 5" instead of one line per chunk. */
function groupSourcesByDocument(sources: SourceRef[]): { filename: string; chunkIndexes: number[] }[] {
  const byDocument = new Map<string, { filename: string; chunkIndexes: number[] }>();
  for (const source of sources) {
    const existing = byDocument.get(source.documentId);
    if (existing) {
      existing.chunkIndexes.push(source.chunkIndex);
    } else {
      byDocument.set(source.documentId, { filename: source.filename, chunkIndexes: [source.chunkIndex] });
    }
  }
  return Array.from(byDocument.values());
}

/**
 * Compact by design (section "Source UI"/"Source preview" in the phase
 * brief explicitly warns against a large citation panel): one line per
 * source document, expandable in place to show the retrieved passage(s)
 * that actually grounded the answer — never a separate modal or a
 * redesign of the message bubble itself.
 */
function SourcesFooter({ sources }: { sources: SourceRef[] }) {
  const [expandedDocumentId, setExpandedDocumentId] = useState<string | null>(null);
  const grouped = groupSourcesByDocument(sources);
  const chunksByDocument = new Map<string, SourceRef[]>();
  for (const source of sources) {
    const list = chunksByDocument.get(source.documentId) ?? [];
    list.push(source);
    chunksByDocument.set(source.documentId, list);
  }

  return (
    <div className="mt-2 border-t border-line pt-2 text-xs text-ink-muted">
      <p className="mb-1 font-medium text-ink-faint">Sources</p>
      <ul className="space-y-1">
        {grouped.map((group) => {
          const documentId = sources.find((s) => s.filename === group.filename)!.documentId;
          const isExpanded = expandedDocumentId === documentId;
          return (
            <li key={documentId}>
              <button
                type="button"
                onClick={() => setExpandedDocumentId(isExpanded ? null : documentId)}
                className="flex w-full items-start gap-1.5 text-left transition-colors hover:text-ink"
              >
                <FileText size={12} strokeWidth={1.75} className="mt-0.5 shrink-0 text-ink-faint" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">
                  {group.filename} · chunk{group.chunkIndexes.length > 1 ? "s" : ""}{" "}
                  {group.chunkIndexes.map((i) => i + 1).join(", ")}
                </span>
                {isExpanded ? (
                  <ChevronUp size={12} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden="true" />
                ) : (
                  <ChevronDown size={12} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden="true" />
                )}
              </button>
              {isExpanded && (
                <div className="mt-1 space-y-1.5 pl-[18px]">
                  {chunksByDocument.get(documentId)!.map((chunk) => (
                    <blockquote
                      key={chunk.chunkId}
                      className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded border border-line bg-paper px-2.5 py-2 text-ink-muted scrollbar-thin"
                    >
                      {chunk.content}
                    </blockquote>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Inline editor shown in place of a user's bubble. Enter saves, Shift+Enter adds a line, Escape cancels. */
function EditForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const trimmed = value.trim();
  const tooLong = value.length > MAX_MESSAGE_LENGTH;
  const canSave = trimmed.length > 0 && !tooLong;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);

  function submit() {
    if (canSave) onSubmit(trimmed);
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="w-full"
    >
      <label htmlFor="edit-message" className="sr-only">
        Edit your message
      </label>
      <textarea
        ref={ref}
        id="edit-message"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
        rows={2}
        aria-invalid={tooLong}
        aria-describedby="edit-hint"
        className="input-base max-h-60 w-full resize-none bg-paper-raised text-ink"
      />
      <p id="edit-hint" className={cn("mt-1 text-xs", tooLong ? "text-danger-500" : "text-ink-faint")}>
        {tooLong
          ? `${value.length}/${MAX_MESSAGE_LENGTH} characters`
          : "Saving replaces this message and every reply after it."}
      </p>
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-8 rounded border border-line px-3 text-sm text-ink hover:border-line-strong [@media(pointer:coarse)]:h-10"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!canSave}
          className="h-8 rounded-md bg-moss-500 px-3 text-sm font-medium text-on-accent hover:bg-moss-600 disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:h-10"
        >
          Save &amp; resend
        </button>
      </div>
    </form>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Clipboard can be denied (permissions / insecure context). Report
    // failure so the UI never claims "Copied" when nothing was copied.
    return false;
  }
}

export interface MessageBubbleProps {
  message: ChatMessage;
  /** True for the final message in the conversation (only it can be regenerated). */
  isLast?: boolean;
  /** True while any reply is being generated — conflicting actions are disabled. */
  isBusy?: boolean;
  isEditing?: boolean;
  onEditStart?: (id: string) => void;
  onEditCancel?: () => void;
  onEditSubmit?: (id: string, text: string) => void;
  onRegenerate?: (id: string) => void;
}

function MessageBubbleImpl({
  message,
  isLast = false,
  isBusy = false,
  isEditing = false,
  onEditStart,
  onEditCancel,
  onEditSubmit,
  onRegenerate,
}: MessageBubbleProps) {
  const isUser = message.role === "user";
  const [showSources, setShowSources] = useState(true);
  const hasSources = !isUser && !!message.sources && message.sources.length > 0;

  return (
    <div className={cn("group/message flex min-w-0 flex-col", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "min-w-0 max-w-[92%] px-4 py-2.5 sm:max-w-[80%]",
          isUser && !isEditing && "rounded-2xl rounded-br-md bg-moss-500 text-sm leading-relaxed text-on-accent shadow-subtle",
          !isUser && "rounded-lg text-ink",
          isEditing && "w-full max-w-full rounded-lg border border-line-strong bg-paper-raised px-3 py-2.5 text-ink shadow-subtle sm:max-w-full"
        )}
        aria-busy={message.status === "streaming"}
      >
        {isUser && message.attachedFilename && (
          <div className={cn("mb-1.5 flex items-center gap-1.5 border-b pb-1.5 text-xs", isEditing ? "border-line text-ink-muted" : "border-on-accent/25 text-on-accent/85")}>
            <FileText size={12} strokeWidth={1.75} aria-hidden="true" />
            <span className="truncate">Attached: {message.attachedFilename}</span>
          </div>
        )}

        {!isUser && (
          <div className="mb-1 flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-moss-500" aria-hidden="true" />
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-faint">Nexora</span>
          </div>
        )}

        {isUser ? (
          isEditing ? (
            <EditForm
              initial={message.content}
              onSubmit={(text) => onEditSubmit?.(message.id, text)}
              onCancel={() => onEditCancel?.()}
            />
          ) : (
            // pre-wrap keeps the person's own line breaks; break-words stops long URLs overflowing.
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          )
        ) : message.content ? (
          <Markdown content={message.content} />
        ) : (
          <span role="status" className="text-sm text-ink-faint">
            {message.status === "streaming" ? "Thinking…" : ""}
          </span>
        )}

        {message.status === "streaming" && message.content && (
          <span
            aria-hidden="true"
            className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-ink-faint"
          />
        )}

        {message.status === "incomplete" && (
          <div className="mt-2 flex items-center gap-1.5 border-t border-line pt-2 text-xs text-clay-500">
            <AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />
            This response was interrupted before it finished.
          </div>
        )}

        {!isUser && message.notice && (
          <div className="mt-2 flex items-start gap-1.5 border-t border-line pt-2 text-xs text-ink-muted">
            <Info size={12} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>{presentNotice(message.notice).message}</span>
          </div>
        )}

        {hasSources && showSources && <SourcesFooter sources={message.sources!} />}
      </div>

      <MessageActions
        message={{
          id: message.id,
          role: message.role,
          status: message.status,
          content: message.content,
          isLast,
          isBusy,
          hasSources,
          isEditing,
        }}
        sourcesCount={message.sources?.length ?? 0}
        sourcesOpen={showSources}
        onCopy={() => copyText(message.content)}
        onEdit={() => onEditStart?.(message.id)}
        onRegenerate={() => onRegenerate?.(message.id)}
        onToggleSources={() => setShowSources((v) => !v)}
      />
    </div>
  );
}

/**
 * Memoized: during streaming only the last message's props change, so
 * earlier messages skip re-rendering (and re-parsing their Markdown) on
 * every incoming chunk. Callers pass stable (useCallback) handlers.
 */
export const MessageBubble = memo(MessageBubbleImpl);
