"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, MessageSquare, Pencil, Search, SquarePen, Trash2, X, AlertTriangle } from "lucide-react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { debounce } from "@/lib/utils/debounce";
import { parseSnippet, type ConversationSearchResult } from "@/lib/conversations/search";
import {
  MAX_CONVERSATION_TITLE_LENGTH,
  MIN_SEARCH_QUERY_LENGTH,
  normalizeTitle,
  renameConversationSchema,
} from "@/lib/validation/conversation";
import { presentThrown } from "@/lib/chat/error-state";
import { toRequestError } from "@/lib/chat/request";
import { cn } from "@/lib/utils";

export interface ConversationItem {
  id: string;
  title: string;
  updatedAt: string;
}

interface RowData extends ConversationItem {
  snippet?: string | null;
}

const SEARCH_DEBOUNCE_MS = 300;

// Fixed locale + UTC so server-rendered and client-rendered dates are identical (no hydration mismatch).
const dateFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const formatDate = (iso: string) => dateFormat.format(new Date(iso));

const iconButton =
  "flex h-9 w-9 shrink-0 items-center justify-center rounded text-ink-muted transition-colors " +
  "hover:bg-paper hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11";

export function ConversationList({
  initialConversations,
  limitReached,
}: {
  initialConversations: ConversationItem[];
  /** True when the server returned its maximum page — older ones are reachable via search. */
  limitReached: boolean;
}) {
  const router = useRouter();
  const [items, setItems] = useState<ConversationItem[]>(initialConversations);

  // --- search ---
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ConversationSearchResult[] | null>(null);
  const [searchStatus, setSearchStatus] = useState<"idle" | "loading" | "error">("idle");
  const [searchError, setSearchError] = useState<string | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const latestQuery = useRef("");
  const searchInputRef = useRef<HTMLInputElement>(null);

  // --- rename / delete ---
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ConversationItem | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const runSearch = useMemo(
    () =>
      debounce(async (q: string) => {
        searchAbort.current?.abort();
        const controller = new AbortController();
        searchAbort.current = controller;
        try {
          const res = await fetch(`/api/conversations/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
          if (!res.ok) throw await toRequestError(res);
          const data = (await res.json()) as { results: ConversationSearchResult[] };
          // A slower, older response must never overwrite a newer query's results.
          if (latestQuery.current !== q) return;
          setResults(data.results);
          setSearchStatus("idle");
        } catch (error) {
          if (controller.signal.aborted) return;
          if (latestQuery.current !== q) return;
          setSearchError(presentThrown(error).message);
          setSearchStatus("error");
        }
      }, SEARCH_DEBOUNCE_MS),
    []
  );

  useEffect(
    () => () => {
      runSearch.cancel();
      searchAbort.current?.abort();
    },
    [runSearch]
  );

  function handleQueryChange(value: string) {
    setQuery(value);
    const trimmed = value.replace(/\s+/g, " ").trim();
    latestQuery.current = trimmed;
    runSearch.cancel();
    searchAbort.current?.abort();
    setSearchError(null);

    if (trimmed.length < MIN_SEARCH_QUERY_LENGTH) {
      // Empty (or too short) search shows the normal list again.
      setResults(null);
      setSearchStatus("idle");
      return;
    }
    setSearchStatus("loading");
    void runSearch(trimmed);
  }

  function clearSearch() {
    handleQueryChange("");
    searchInputRef.current?.focus();
  }

  const isSearching = results !== null || searchStatus !== "idle";
  const rows: RowData[] =
    results !== null
      ? results.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt, snippet: r.snippet }))
      : items;

  function setTitleEverywhere(id: string, title: string) {
    setItems((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)));
    setResults((prev) => prev && prev.map((r) => (r.id === id ? { ...r, title } : r)));
  }
  function removeEverywhere(id: string) {
    setItems((prev) => prev.filter((c) => c.id !== id));
    setResults((prev) => prev && prev.filter((r) => r.id !== id));
  }

  function startRename(row: RowData) {
    setNotice(null);
    setRenameError(null);
    setRenameValue(row.title);
    setRenamingId(row.id);
  }
  function stopRename(id: string) {
    setRenamingId(null);
    setRenameError(null);
    requestAnimationFrame(() => document.getElementById(`rename-${id}`)?.focus());
  }

  async function commitRename(row: RowData) {
    const parsed = renameConversationSchema.safeParse({ title: renameValue });
    if (!parsed.success) {
      setRenameError(parsed.error.issues[0]?.message ?? "Invalid title");
      return;
    }
    const title = parsed.data.title;
    if (title === row.title) return stopRename(row.id);

    // Optimistic: renaming is trivially reversible, so show it instantly and roll back on failure.
    const previousTitle = row.title;
    setTitleEverywhere(row.id, title);
    stopRename(row.id);
    try {
      const res = await fetch(`/api/conversations/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) throw await toRequestError(res);
      const data = (await res.json()) as { conversation: { title: string } };
      setTitleEverywhere(row.id, data.conversation.title);
      router.refresh(); // keep the sidebar's "Recent" list in step
    } catch (error) {
      setTitleEverywhere(row.id, previousTitle);
      setNotice(`Couldn't rename this conversation. ${presentThrown(error).message}`);
    }
  }

  async function confirmDelete() {
    const target = deleteTarget;
    if (!target) return;
    setDeletePending(true);
    try {
      const res = await fetch(`/api/conversations/${target.id}`, { method: "DELETE" });
      // 404 means it's already gone (deleted elsewhere) — the list should drop it too.
      if (!res.ok && res.status !== 404) throw await toRequestError(res);
      removeEverywhere(target.id);
      setDeleteTarget(null);
      router.refresh();
      searchInputRef.current?.focus();
    } catch (error) {
      setDeleteTarget(null);
      setNotice(`Couldn't delete "${target.title}". ${presentThrown(error).message}`);
    } finally {
      setDeletePending(false);
    }
  }

  const trimmedQuery = query.replace(/\s+/g, " ").trim();
  const tooShort = trimmedQuery.length > 0 && trimmedQuery.length < MIN_SEARCH_QUERY_LENGTH;

  return (
    <div>
      <div className="relative mb-4">
        <label htmlFor="conversation-search" className="sr-only">
          Search conversations
        </label>
        <Search size={15} strokeWidth={1.75} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" aria-hidden="true" />
        <input
          ref={searchInputRef}
          id="conversation-search"
          type="search"
          value={query}
          onChange={(event) => handleQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              clearSearch();
            }
          }}
          placeholder="Search titles and messages"
          autoComplete="off"
          maxLength={100}
          aria-describedby="search-hint"
          className="input-base pl-9 pr-10 [&::-webkit-search-cancel-button]:hidden"
        />
        {query && (
          <button type="button" onClick={clearSearch} aria-label="Clear search" className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded text-ink-muted hover:text-ink">
            <X size={15} strokeWidth={2} aria-hidden="true" />
          </button>
        )}
      </div>
      <p id="search-hint" className="sr-only">
        Type at least {MIN_SEARCH_QUERY_LENGTH} characters. Searches conversation titles and message text.
      </p>

      {notice && (
        <div role="alert" className="mb-4 flex items-start justify-between gap-2 rounded-lg border border-danger-50 bg-danger-50 px-3 py-2 text-sm text-danger-500 shadow-subtle">
          <span className="flex min-w-0 items-start gap-1.5">
            <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="break-words">{notice}</span>
          </span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="rounded p-0.5 hover:bg-danger-50">
            <X size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Polite, non-visual announcement of search progress/results. */}
      <p role="status" className="sr-only">
        {searchStatus === "loading" ? "Searching…" : results !== null ? `${results.length} ${results.length === 1 ? "result" : "results"}` : ""}
      </p>

      {tooShort && <p className="mb-3 text-xs text-ink-faint">Type at least {MIN_SEARCH_QUERY_LENGTH} characters to search.</p>}
      {searchStatus === "loading" && <p className="mb-3 text-xs text-ink-faint" aria-hidden="true">Searching…</p>}
      {searchStatus === "error" && (
        <p role="alert" className="mb-3 text-sm text-danger-500">
          {searchError}
        </p>
      )}

      {!isSearching && items.length === 0 ? (
        <EmptyState
          icon={MessageSquare}
          title="No conversations yet"
          description="Start a new conversation to begin — your threads will show up here once you do."
          action={
            <Link href="/chat" className="inline-flex h-10 items-center justify-center gap-2 rounded bg-moss-500 px-4 text-sm font-medium text-on-accent transition-colors hover:bg-moss-600">
              <SquarePen size={15} strokeWidth={1.75} aria-hidden="true" />
              Start a new conversation
            </Link>
          }
        />
      ) : results !== null && results.length === 0 ? (
        <EmptyState
          icon={Search}
          title="No matching conversations"
          description={`Nothing matched “${trimmedQuery}”. Try a different word, or a shorter one — searches match the start of words in messages.`}
        />
      ) : (
        rows.length > 0 && (
          <ul className={cn("divide-y divide-line card-surface", searchStatus === "loading" && "opacity-60")}>
            {rows.map((row) => (
              <li key={row.id} className="flex items-center gap-1 pr-2">
                {renamingId === row.id ? (
                  <form
                    className="flex min-w-0 flex-1 items-start gap-1 px-3 py-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void commitRename(row);
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <label htmlFor={`rename-input-${row.id}`} className="sr-only">
                        Conversation title
                      </label>
                      <input
                        id={`rename-input-${row.id}`}
                        autoFocus
                        value={renameValue}
                        onChange={(event) => {
                          setRenameValue(event.target.value);
                          setRenameError(null);
                        }}
                        onFocus={(event) => event.currentTarget.select()}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            stopRename(row.id);
                          }
                        }}
                        maxLength={MAX_CONVERSATION_TITLE_LENGTH + 20}
                        aria-invalid={!!renameError}
                        aria-describedby={renameError ? `rename-error-${row.id}` : undefined}
                        className="input-base py-1.5"
                      />
                      {renameError && (
                        <p id={`rename-error-${row.id}`} role="alert" className="mt-1 text-xs text-danger-500">
                          {renameError}
                        </p>
                      )}
                    </div>
                    <button type="submit" aria-label="Save title" title="Save (Enter)" className={iconButton}>
                      <Check size={16} strokeWidth={2} aria-hidden="true" />
                    </button>
                    <button type="button" onClick={() => stopRename(row.id)} aria-label="Cancel rename" title="Cancel (Esc)" className={iconButton}>
                      <X size={16} strokeWidth={2} aria-hidden="true" />
                    </button>
                  </form>
                ) : (
                  <>
                    <Link href={`/chat?c=${row.id}`} className="min-w-0 flex-1 px-4 py-3 text-sm hover:bg-paper">
                      <span className="flex items-center justify-between gap-4">
                        <span className="truncate text-ink">{row.title}</span>
                        <span className="hidden shrink-0 text-xs text-ink-faint sm:inline">{formatDate(row.updatedAt)}</span>
                      </span>
                      {row.snippet && (
                        <span className="mt-0.5 block truncate text-xs text-ink-muted">
                          {parseSnippet(row.snippet).map((part, i) =>
                            part.highlighted ? (
                              <mark key={i} className="rounded-sm bg-moss-100 px-0.5 text-ink">
                                {part.text}
                              </mark>
                            ) : (
                              <span key={i}>{part.text}</span>
                            )
                          )}
                        </span>
                      )}
                    </Link>
                    <button id={`rename-${row.id}`} type="button" onClick={() => startRename(row)} aria-label={`Rename ${row.title}`} title="Rename" className={iconButton}>
                      <Pencil size={15} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteTarget({ id: row.id, title: row.title, updatedAt: row.updatedAt })}
                      aria-label={`Delete ${row.title}`}
                      title="Delete"
                      className={cn(iconButton, "hover:bg-danger-50 hover:text-danger-500")}
                    >
                      <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )
      )}

      {!isSearching && limitReached && (
        <p className="mt-3 text-xs text-ink-faint">Showing your most recent conversations. Use search to find older ones.</p>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete this conversation?"
        description={`“${deleteTarget ? normalizeTitle(deleteTarget.title) : ""}” and all of its messages will be permanently deleted. Documents you've uploaded are not deleted.`}
        pending={deletePending}
        onConfirm={confirmDelete}
        onCancel={() => !deletePending && setDeleteTarget(null)}
      />
    </div>
  );
}
