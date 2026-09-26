"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertTriangle, X } from "lucide-react";
import { Composer, type ComposerDocument } from "@/components/chat/composer";
import { MessageBubble, type ChatMessage } from "@/components/chat/message-bubble";
import { SuggestedPrompts } from "@/components/chat/suggested-prompts";
import { presentError, presentThrown, type ErrorPresentation } from "@/lib/chat/error-state";
import { buildChatRequestBody, isPersistedId, makeTempId, toRequestError, type ChatAction } from "@/lib/chat/request";
import { consumeChatStream } from "@/lib/chat/stream";

/** If no bytes arrive for this long, the request is aborted so the UI can never hang in "Generating…". */
const STALL_TIMEOUT_MS = 60_000;

interface ChatErrorState {
  presentation: ErrorPresentation;
  /** What the Retry button re-runs. Absent when retrying can't help (auth, validation, …). */
  retry?: ChatAction;
}

interface RunOptions {
  /** Messages to put back if this action fails before/without changing anything server-side (regenerate, edit). */
  restore?: ChatMessage[];
  /** Local id of the user bubble this run created, swapped for the server's id once known. */
  tempUserId?: string;
}

function updateMessage(
  messages: ChatMessage[],
  id: string,
  updater: (message: ChatMessage) => ChatMessage
): ChatMessage[] {
  return messages.map((m) => (m.id === id ? updater(m) : m));
}

/** A conversation that ends with a saved user message and no reply (e.g. the tab was closed mid-generation). */
function unansweredTail(messages: ChatMessage[]): ChatErrorState | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user" || !isPersistedId(last.id)) return null;
  return {
    presentation: presentError({ code: "provider_error", serverMessage: "This message didn't get a response." }),
    retry: { kind: "retry", messageId: last.id },
  };
}

export function Chat({
  initialConversationId,
  initialMessages,
  documents = [],
  initialDocumentId = null,
  truncatedHistory = false,
}: {
  initialConversationId: string | null;
  initialMessages: ChatMessage[];
  documents?: ComposerDocument[];
  initialDocumentId?: string | null;
  /** True when the conversation has more messages than were loaded (see app/(app)/chat/page.tsx). */
  truncatedHistory?: boolean;
}) {
  const router = useRouter();
  const [conversationId, setConversationId] = useState(initialConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<ChatErrorState | null>(() => unansweredTail(initialMessages));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [attachedDocument, setAttachedDocument] = useState<ComposerDocument | null>(
    () => documents.find((d) => d.id === initialDocumentId) ?? null
  );
  const [composerPrefill, setComposerPrefill] = useState<{ text: string; nonce: number } | null>(null);
  const handleSuggestedPrompt = useCallback((text: string) => {
    setComposerPrefill((prev) => ({ text, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const stalledRef = useRef(false);
  const unmountedRef = useRef(false);
  // Latest values for stable (memo-friendly) handlers.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const streamingRef = useRef(isStreaming);
  streamingRef.current = isStreaming;

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      // Leaving the page mid-generation: abort the request. The server
      // then stores whatever it had as an interrupted message (or, for a
      // regeneration, keeps the original reply).
      unmountedRef.current = true;
      abortRef.current?.abort();
    };
  }, []);

  // Smart auto-scroll: only follow new content if the user hasn't
  // deliberately scrolled up to read earlier messages.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distanceFromBottom < 80;
  }

  async function runStream(action: ChatAction, options: RunOptions = {}) {
    const { restore, tempUserId } = options;
    setError(null);
    setIsStreaming(true);
    setAnnouncement("Assistant is responding…");
    isAtBottomRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;
    stalledRef.current = false;

    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const armStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        stalledRef.current = true;
        controller.abort();
      }, STALL_TIMEOUT_MS);
    };

    const assistantId = makeTempId();
    setMessages((prev) => [...prev, { id: assistantId, role: "assistant", content: "", status: "streaming" }]);

    const isRegenerate = action.kind === "regenerate";
    let serverAccepted = false;
    let userMessageId: string | undefined;
    let newConversationId: string | null = null;
    let received = "";

    /** What Retry should do next, given how far this run got. */
    const retryFor = (): ChatAction | undefined => {
      if (isRegenerate) return { kind: "regenerate", messageId: action.messageId };
      if (!serverAccepted) return action; // nothing reached the server — repeat exactly
      return userMessageId ? { kind: "retry", messageId: userMessageId } : undefined;
    };

    const fail = (presentation: ErrorPresentation, keepPartial: boolean, persistedId?: string) => {
      if (isRegenerate || (!serverAccepted && restore)) {
        // The server still has the original state — put it back exactly.
        if (restore) setMessages(restore);
        else setMessages((prev) => prev.filter((m) => m.id !== assistantId));
      } else if (keepPartial && received.trim()) {
        setMessages((prev) =>
          updateMessage(prev, assistantId, (m) => ({ ...m, id: persistedId ?? m.id, status: "incomplete" }))
        );
      } else {
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
      }
      setError({ presentation, retry: presentation.retryable ? retryFor() : undefined });
      setAnnouncement(presentation.message);
    };

    try {
      armStallTimer();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildChatRequestBody(conversationId, action)),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) throw await toRequestError(res);

      serverAccepted = true;
      newConversationId = res.headers.get("X-Conversation-Id");
      userMessageId = res.headers.get("X-User-Message-Id") ?? undefined;
      if (newConversationId && !conversationId) setConversationId(newConversationId);

      // Swap the local placeholder id for the saved one so Edit works on
      // this message immediately, without a page reload.
      if (tempUserId && userMessageId) {
        const savedId = userMessageId;
        setMessages((prev) => updateMessage(prev, tempUserId, (m) => ({ ...m, id: savedId })));
      }

      const outcome = await consumeChatStream(res.body, {
        onActivity: armStallTimer,
        onChunk: (text) => {
          received += text;
          setMessages((prev) =>
            updateMessage(prev, assistantId, (m) => ({ ...m, content: m.content + text }))
          );
        },
      });

      if (outcome.status === "done" && outcome.done) {
        const { messageId, sources, notice } = outcome.done;
        setMessages((prev) =>
          updateMessage(prev, assistantId, (m) => ({ ...m, id: messageId, status: "complete", sources, notice }))
        );
        setAnnouncement("Response complete.");
      } else if (outcome.status === "error" && outcome.error) {
        fail(
          presentError({ code: outcome.error.code, serverMessage: outcome.error.message }),
          outcome.error.partial,
          outcome.error.messageId
        );
      } else {
        // Stream ended with no terminal event: never present it as complete.
        fail(
          presentError({
            clientNetworkFailure: outcome.readFailed,
            code: outcome.readFailed ? undefined : "provider_error",
            serverMessage: "The connection was interrupted before the response finished.",
          }),
          true
        );
      }

      router.refresh();
      if (newConversationId) {
        router.replace(`/chat?c=${newConversationId}`, { scroll: false });
      }
    } catch (err) {
      if (unmountedRef.current) return; // navigating away — nothing left to update
      if (controller.signal.aborted && !stalledRef.current) {
        // The person pressed Stop.
        if (isRegenerate || (!serverAccepted && restore)) {
          if (restore) setMessages(restore);
        } else if (received.trim()) {
          setMessages((prev) => updateMessage(prev, assistantId, (m) => ({ ...m, status: "incomplete" })));
        } else {
          setMessages((prev) => prev.filter((m) => m.id !== assistantId));
        }
        setAnnouncement("Stopped.");
        if (serverAccepted) router.refresh();
      } else if (stalledRef.current) {
        fail(
          presentError({
            code: "provider_error",
            serverMessage: "The response stalled and was stopped. Please try again.",
          }),
          true
        );
      } else {
        fail(presentThrown(err), false);
      }
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
      abortRef.current = null;
      if (!unmountedRef.current) setIsStreaming(false);
    }
  }

  const runStreamRef = useRef(runStream);
  runStreamRef.current = runStream;

  function handleSend(text: string) {
    const doc = attachedDocument;
    const tempUserId = makeTempId();
    setEditingId(null);
    setMessages((prev) => [
      ...prev,
      { id: tempUserId, role: "user", content: text, status: "complete", attachedFilename: doc?.filename ?? null },
    ]);
    setAttachedDocument(null);
    void runStream({ kind: "send", content: text, documentId: doc?.id }, { tempUserId });
  }

  const handleRegenerate = useCallback((id: string) => {
    if (streamingRef.current) return;
    const previous = messagesRef.current;
    if (!previous.some((m) => m.id === id)) return;
    setEditingId(null);
    // The old reply is hidden while the new one streams in its place, and
    // restored untouched if regeneration fails or is stopped.
    setMessages(previous.filter((m) => m.id !== id));
    void runStreamRef.current({ kind: "regenerate", messageId: id }, { restore: previous });
  }, []);

  const handleEditStart = useCallback((id: string) => {
    if (!streamingRef.current) setEditingId(id);
  }, []);
  const handleEditCancel = useCallback(() => setEditingId(null), []);

  const handleEditSubmit = useCallback((id: string, text: string) => {
    if (streamingRef.current) return;
    const previous = messagesRef.current;
    const index = previous.findIndex((m) => m.id === id);
    const original = previous[index];
    if (index < 0 || !original || original.role !== "user") return;
    setEditingId(null);
    if (text === original.content) return; // nothing changed — don't resend

    const tempUserId = makeTempId();
    // Everything after the edited message belongs to the old branch.
    setMessages([
      ...previous.slice(0, index),
      { id: tempUserId, role: "user", content: text, status: "complete", attachedFilename: original.attachedFilename },
    ]);
    void runStreamRef.current({ kind: "edit", messageId: id, content: text }, { restore: previous, tempUserId });
  }, []);

  function handleRetry() {
    const retry = error?.retry;
    if (!retry || isStreaming) return;
    setError(null);

    switch (retry.kind) {
      case "regenerate":
        handleRegenerate(retry.messageId);
        break;
      case "edit":
        handleEditSubmit(retry.messageId, retry.content);
        break;
      case "retry": {
        // Drop any failed/incomplete attempt so it isn't left above the fresh one.
        setMessages((prev) => prev.filter((m) => !(m.role === "assistant" && m.status === "incomplete")));
        void runStream(retry);
        break;
      }
      case "send": {
        // The unsent bubble is already on screen; reuse it rather than adding another.
        const pending = [...messagesRef.current].reverse().find((m) => m.role === "user" && !isPersistedId(m.id));
        void runStream(retry, { tempUserId: pending?.id });
        break;
      }
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  const lastId = messages[messages.length - 1]?.id;

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col lg:h-dvh">
      {/* Screen-reader status: streamed text itself isn't live (it would be announced word by word). */}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto scrollbar-thin px-3 py-6 sm:px-8"
      >
        {messages.length === 0 ? (
          <div className="mx-auto flex max-w-2xl flex-col items-center px-2 pt-10 text-center sm:pt-16">
            <span className="brand-mark mb-5 h-10 w-10 rounded-[10px]" aria-hidden="true" />
            <h1 className="font-serif text-2xl text-ink sm:text-3xl">Nexora</h1>
            <p className="mt-2 max-w-sm text-sm text-ink-muted sm:text-base">
              Your knowledge, conversations and documents — in one intelligent workspace.
            </p>
            <div className="mt-8 w-full max-w-xl">
              <SuggestedPrompts onSelect={handleSuggestedPrompt} />
            </div>
          </div>
        ) : (
          <section aria-label="Conversation" aria-busy={isStreaming} className="mx-auto flex max-w-prose flex-col gap-3">
            {truncatedHistory && (
              <p className="text-center text-xs text-ink-faint">Earlier messages in this conversation aren&apos;t shown.</p>
            )}
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                isLast={message.id === lastId}
                isBusy={isStreaming}
                isEditing={editingId === message.id}
                onEditStart={handleEditStart}
                onEditCancel={handleEditCancel}
                onEditSubmit={handleEditSubmit}
                onRegenerate={handleRegenerate}
              />
            ))}
          </section>
        )}
      </div>

      {error && (
        <div className="mx-auto w-full max-w-prose px-3 pb-2 sm:px-8">
          <div
            role="alert"
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger-50 bg-danger-50 px-3 py-2 text-sm text-danger-500 shadow-subtle"
          >
            <span className="flex min-w-0 items-start gap-1.5">
              <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0 break-words">
                <span className="font-medium">{error.presentation.title}.</span> {error.presentation.message}
              </span>
            </span>
            <span className="flex items-center gap-3">
              {error.presentation.kind === "auth" && (
                <Link href="/login" className="font-medium underline underline-offset-2">
                  Sign in
                </Link>
              )}
              {error.retry && (
                <button
                  type="button"
                  onClick={handleRetry}
                  disabled={isStreaming}
                  className="font-medium underline underline-offset-2 disabled:opacity-50"
                >
                  Retry
                </button>
              )}
              <button
                type="button"
                onClick={() => setError(null)}
                aria-label="Dismiss error"
                className="rounded p-0.5 hover:bg-danger-50"
              >
                <X size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            </span>
          </div>
        </div>
      )}

      <div className="border-t border-line bg-gradient-to-t from-paper via-paper to-transparent pt-2">
        <div className="mx-auto w-full max-w-prose">
          <Composer
            onSend={handleSend}
            onStop={handleStop}
            isStreaming={isStreaming}
            documents={documents}
            attachedDocument={attachedDocument}
            onAttach={setAttachedDocument}
            onDetach={() => setAttachedDocument(null)}
            prefill={composerPrefill}
          />
        </div>
      </div>
    </div>
  );
}
