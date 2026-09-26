import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, fakeUuid, nextTimestamp, readEvents, type FakeDb } from "@/lib/testing/fake-supabase";

// --- Module mocks (hoisted). Everything the route talks to over the network is replaced. ---
const state = vi.hoisted(() => ({
  client: null as any,
  providerCalls: [] as { systemInstruction: string; history: { role: string; parts: { text: string }[] }[] }[],
  chunks: ["Hello ", "world"] as string[],
  failBeforeChunks: false,
  failAfterChunks: false,
  embedFails: false,
  rpcCalls: [] as any[],
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));

vi.mock("@/lib/ai/gemini", () => ({
  GeminiProvider: class {
    async *streamReply(params: any) {
      state.providerCalls.push(params);
      if (state.failBeforeChunks) throw new Error("429 quota exceeded for project 12345");
      for (const chunk of state.chunks) yield chunk;
      if (state.failAfterChunks) throw new Error("fetch failed: ECONNRESET");
    }
  },
}));

vi.mock("@/lib/rag/embedding-provider", () => ({
  GeminiEmbeddingProvider: class {
    model = "fake";
    dimensions = 3;
    async embedText() {
      if (state.embedFails) throw new Error("fetch failed");
      return [1, 0, 0];
    }
    async embedTexts() {
      return [[1, 0, 0]];
    }
  },
}));

import { POST } from "@/app/api/chat/route";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";

let db: FakeDb;

// Same clock the fake uses for its own inserts, so seeded rows always sort before new ones.
const ts = nextTimestamp;

function useUser(userId: string | null) {
  const fake = createFakeSupabase({ userId });
  db = fake.db;
  state.client = fake.client;
}

/** Seeds a conversation owned by `owner` with messages in order; returns ids. */
function seed(
  owner: string,
  messages: { role: "user" | "assistant"; content: string; status?: "complete" | "incomplete"; metadata?: any }[]
) {
  const conversationId = fakeUuid();
  db.tables.conversations!.push({ id: conversationId, user_id: owner, title: "Seeded", created_at: ts(), updated_at: ts() });
  const ids = messages.map((m) => {
    const id = fakeUuid();
    db.tables.messages!.push({
      id,
      conversation_id: conversationId,
      user_id: owner,
      role: m.role,
      content: m.content,
      status: m.status ?? "complete",
      metadata: m.metadata ?? null,
      created_at: ts(),
    });
    return id;
  });
  return { conversationId, ids };
}

function seedDocument(owner: string, filename = "notes.pdf", status = "ready") {
  const id = fakeUuid();
  db.tables.documents!.push({ id, user_id: owner, filename, extraction_status: status, created_at: ts() });
  return id;
}

function link(conversationId: string, documentId: string, owner: string) {
  db.tables.conversation_documents!.push({ conversation_id: conversationId, document_id: documentId, user_id: owner, created_at: ts() });
}

function mockChunkSearch(rows: { id: string; document_id: string; chunk_index: number; content: string; similarity: number }[]) {
  db.rpcHandlers.match_document_chunks = (args) => {
    state.rpcCalls.push(args);
    return {
      data: rows
        .filter((r) => (args.filter_document_ids as string[]).includes(r.document_id))
        .map((r) => ({ ...r, metadata: { filename: "x", contentType: "application/pdf" } })),
      error: null,
    };
  };
}

function post(body: unknown) {
  return POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

const messagesOf = (conversationId: string): any[] =>
  db.tables.messages!.filter((m) => m.conversation_id === conversationId).sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

beforeEach(() => {
  state.providerCalls = [];
  state.chunks = ["Hello ", "world"];
  state.failBeforeChunks = false;
  state.failAfterChunks = false;
  state.embedFails = false;
  state.rpcCalls = [];
  useUser(ALICE);
});

// ---------------------------------------------------------------------------
describe("auth + error shape", () => {
  it("rejects unauthenticated requests with a machine-readable code", async () => {
    useUser(null);
    const res = await post({ content: "hi" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "You must be signed in.", code: "unauthenticated" });
  });

  it("returns a validation code for a malformed request", async () => {
    const res = await post({ editMessageId: fakeUuid(), conversationId: fakeUuid() }); // edit without content
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("invalid_request");
  });

  it("reports an unready attached document as a document error (409), not a generic validation error", async () => {
    const docId = seedDocument(ALICE, "slow.pdf", "processing");
    const res = await post({ content: "hi", documentId: docId });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("document_error");
  });
});

// ---------------------------------------------------------------------------
describe("rate limiting", () => {
  it("returns 429 with a Retry-After header once check_rate_limit reports the caller is over the limit", async () => {
    db.rpcHandlers.check_rate_limit = () => ({
      data: [{ allowed: false, current_count: 21, retry_after_seconds: 17 }],
      error: null,
    });

    const res = await post({ content: "hi" });

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("17");
    const body = await res.json();
    expect(body.code).toBe("rate_limited");
  });

  it("checks the limit before writing any conversation/message rows", async () => {
    db.rpcHandlers.check_rate_limit = () => ({
      data: [{ allowed: false, current_count: 21, retry_after_seconds: 5 }],
      error: null,
    });

    await post({ content: "hi" });

    expect(db.tables.conversations).toEqual([]);
    expect(db.tables.messages).toEqual([]);
  });

  it("proceeds normally when the caller is within the limit", async () => {
    db.rpcHandlers.check_rate_limit = () => ({
      data: [{ allowed: true, current_count: 1, retry_after_seconds: 0 }],
      error: null,
    });

    const res = await post({ content: "hi" });
    expect(res.status).toBe(200);
  });

  it("still allows the request that exactly reaches the configured limit", async () => {
    // e.g. limit=20, this is the 20th request in the window — still allowed.
    db.rpcHandlers.check_rate_limit = () => ({
      data: [{ allowed: true, current_count: 20, retry_after_seconds: 0 }],
      error: null,
    });

    const res = await post({ content: "hi" });
    expect(res.status).toBe(200);
  });

  it("returns 503 (not 429, not a silent bypass) if the rate-limit RPC itself fails — Phase 6 correction: fails closed", async () => {
    db.rpcHandlers.check_rate_limit = () => ({ data: null, error: { message: "db down: connection refused at 10.0.0.5" } });

    const res = await post({ content: "hi" });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("rate_limit_unavailable");
    // Never leak the underlying database error.
    expect(JSON.stringify(body)).not.toMatch(/db down|10\.0\.0\.5|connection refused/);
  });

  it("does not write any conversation/message rows when the limiter is unavailable", async () => {
    db.rpcHandlers.check_rate_limit = () => ({ data: null, error: { message: "db down" } });

    await post({ content: "hi" });

    expect(db.tables.conversations).toEqual([]);
    expect(db.tables.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("regenerate", () => {
  it("replaces the latest assistant reply through the normal pipeline", async () => {
    const { conversationId, ids } = seed(ALICE, [
      { role: "user", content: "Explain RAG" },
      { role: "assistant", content: "OLD ANSWER" },
    ]);

    const res = await post({ conversationId, regenerateMessageId: ids[1] });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-User-Message-Id")).toBe(ids[0]);

    const events = await readEvents(res);
    expect(events.filter((e) => e.type === "chunk").map((e) => e.text).join("")).toBe("Hello world");
    const done = events.find((e) => e.type === "done");
    expect(done).toBeTruthy();

    const msgs = messagesOf(conversationId);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ["user", "Explain RAG"],
      ["assistant", "Hello world"],
    ]);
    expect(msgs[1].id).toBe(done.messageId);
    expect(msgs.some((m) => m.id === ids[1])).toBe(false); // old reply is gone
    expect(msgs[0].id).toBe(ids[0]); // user message untouched, NOT duplicated
  });

  it("never includes the reply being replaced in the model's context", async () => {
    const { conversationId, ids } = seed(ALICE, [
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "STALE SECOND ANSWER" },
    ]);
    await readEvents(await post({ conversationId, regenerateMessageId: ids[3] }));

    const sent = state.providerCalls[0]!.history;
    expect(sent.map((h) => h.role)).toEqual(["user", "model", "user"]);
    expect(JSON.stringify(sent)).not.toContain("STALE SECOND ANSWER");
    expect(sent[2]!.parts[0]!.text).toBe("second question");
  });

  it("can regenerate an interrupted (incomplete) latest reply", async () => {
    const { conversationId, ids } = seed(ALICE, [
      { role: "user", content: "q" },
      { role: "assistant", content: "partial…", status: "incomplete" },
    ]);
    const events = await readEvents(await post({ conversationId, regenerateMessageId: ids[1] }));
    expect(events.at(-1).type).toBe("done");
    const msgs = messagesOf(conversationId);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].status).toBe("complete");
  });

  it("only allows the LATEST message to be regenerated", async () => {
    const { conversationId, ids } = seed(ALICE, [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "a2" },
    ]);
    const res = await post({ conversationId, regenerateMessageId: ids[1] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/most recent/i);
    expect(state.providerCalls).toHaveLength(0);
    expect(messagesOf(conversationId)).toHaveLength(4); // nothing touched
  });

  it("refuses to 'regenerate' a user message", async () => {
    const { conversationId, ids } = seed(ALICE, [{ role: "user", content: "q" }]);
    const res = await post({ conversationId, regenerateMessageId: ids[0] });
    expect(res.status).toBe(400);
    expect(state.providerCalls).toHaveLength(0);
  });

  it("cannot regenerate in another user's conversation (RLS => not found)", async () => {
    const { conversationId, ids } = seed(BOB, [
      { role: "user", content: "bob q" },
      { role: "assistant", content: "bob a" },
    ]);
    const res = await post({ conversationId, regenerateMessageId: ids[1] }); // caller is ALICE
    expect(res.status).toBe(404);
    expect(state.providerCalls).toHaveLength(0);
    expect(messagesOf(conversationId).map((m) => m.content)).toEqual(["bob q", "bob a"]);
  });

  it("cannot target another user's message id inside the caller's own conversation", async () => {
    const mine = seed(ALICE, [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
    const theirs = seed(BOB, [
      { role: "user", content: "bq" },
      { role: "assistant", content: "ba" },
    ]);
    const res = await post({ conversationId: mine.conversationId, regenerateMessageId: theirs.ids[1] });
    expect(res.status).toBe(400);
    expect(messagesOf(theirs.conversationId)).toHaveLength(2);
    expect(messagesOf(mine.conversationId).map((m) => m.content)).toEqual(["q", "a"]);
  });

  it("keeps the ORIGINAL reply when the provider fails before producing anything", async () => {
    const { conversationId, ids } = seed(ALICE, [
      { role: "user", content: "q" },
      { role: "assistant", content: "ORIGINAL" },
    ]);
    state.failBeforeChunks = true;
    const events = await readEvents(await post({ conversationId, regenerateMessageId: ids[1] }));
    const err = events.find((e) => e.type === "error");
    expect(err.code).toBe("rate_limited");
    expect(err.message).not.toMatch(/12345/); // provider internals never leak
    expect(messagesOf(conversationId).map((m) => m.content)).toEqual(["q", "ORIGINAL"]);
  });

  it("keeps the original reply on a mid-stream failure and persists NO partial", async () => {
    const { conversationId, ids } = seed(ALICE, [
      { role: "user", content: "q" },
      { role: "assistant", content: "ORIGINAL" },
    ]);
    state.failAfterChunks = true;
    const events = await readEvents(await post({ conversationId, regenerateMessageId: ids[1] }));
    const err = events.find((e) => e.type === "error");
    expect(err.partial).toBe(true);
    expect(err.messageId).toBeUndefined();
    expect(messagesOf(conversationId).map((m) => [m.content, m.status])).toEqual([
      ["q", "complete"],
      ["ORIGINAL", "complete"],
    ]);
  });

  it("undoes the new reply if the old one can't be retired (never two competing replies)", async () => {
    const { conversationId, ids } = seed(ALICE, [
      { role: "user", content: "q" },
      { role: "assistant", content: "ORIGINAL" },
    ]);
    db.failures.push({ table: "messages", op: "delete" });
    const events = await readEvents(await post({ conversationId, regenerateMessageId: ids[1] }));
    const err = events.find((e) => e.type === "error");
    expect(err.message).toMatch(/original response was kept/i);
    expect(events.some((e) => e.type === "done")).toBe(false);
    expect(messagesOf(conversationId).map((m) => m.content)).toEqual(["q", "ORIGINAL"]);
  });

  it("keeps RAG working: retrieves for the conversation's documents and stores server-derived sources", async () => {
    const { conversationId, ids } = seed(ALICE, [
      { role: "user", content: "What does the doc say about pricing?" },
      { role: "assistant", content: "OLD" },
    ]);
    const docId = seedDocument(ALICE, "pricing.pdf");
    link(conversationId, docId, ALICE);
    mockChunkSearch([{ id: fakeUuid(), document_id: docId, chunk_index: 2, content: "Pricing starts at $10.", similarity: 0.91 }]);
    // The model "fabricates" a citation — sources must NOT depend on it.
    state.chunks = ["According to [S9] fake.pdf p.99, it is free."];

    const events = await readEvents(await post({ conversationId, regenerateMessageId: ids[1] }));
    const done = events.find((e) => e.type === "done");

    // Retrieval ran, scoped to exactly the conversation's document, with the user's question.
    expect(state.rpcCalls).toHaveLength(1);
    expect(state.rpcCalls[0].filter_document_ids).toEqual([docId]);

    // The retrieved passage reached the model, and the RAG system addendum is applied.
    const lastTurn = state.providerCalls[0]!.history.at(-1)!.parts[0]!.text;
    expect(lastTurn).toContain("<retrieved_context>");
    expect(lastTurn).toContain("Pricing starts at $10.");
    expect(state.providerCalls[0]!.systemInstruction).toContain("retrieved_context");

    // Sources are exactly the retrieved chunk, on the event AND in the persisted row.
    expect(done.sources).toHaveLength(1);
    expect(done.sources[0]).toMatchObject({ documentId: docId, filename: "pricing.pdf", chunkIndex: 2, content: "Pricing starts at $10." });
    const saved = messagesOf(conversationId).find((m) => m.id === done.messageId)!;
    expect(saved.metadata.sources).toEqual(done.sources);
    expect(JSON.stringify(saved.metadata)).not.toContain("fake.pdf");
  });

  it("degrades gracefully and says so when retrieval itself fails", async () => {
    const { conversationId, ids } = seed(ALICE, [
      { role: "user", content: "q about the doc" },
      { role: "assistant", content: "OLD" },
    ]);
    const docId = seedDocument(ALICE);
    link(conversationId, docId, ALICE);
    state.embedFails = true;
    vi.spyOn(console, "error").mockImplementation(() => {});

    const events = await readEvents(await post({ conversationId, regenerateMessageId: ids[1] }));
    const done = events.find((e) => e.type === "done");
    expect(done.notice).toBe("retrieval_failed");
    expect(done.sources).toBeUndefined();
    expect(messagesOf(conversationId).at(-1)!.content).toBe("Hello world");
  });
});

// ---------------------------------------------------------------------------
describe("edit + resend", () => {
  it("truncates from the edited message onward and answers the edited text", async () => {
    const { conversationId, ids } = seed(ALICE, [
      { role: "user", content: "Explain RAG" },
      { role: "assistant", content: "stale a1" },
      { role: "user", content: "and chunking?" },
      { role: "assistant", content: "stale a2" },
    ]);

    const res = await post({ conversationId, editMessageId: ids[0], content: "Explain RAG with a simple example" });
    expect(res.status).toBe(200);
    const events = await readEvents(res);
    expect(events.at(-1).type).toBe("done");

    const msgs = messagesOf(conversationId);
    expect(msgs.map((m) => [m.role, m.content])).toEqual([
      ["user", "Explain RAG with a simple example"],
      ["assistant", "Hello world"],
    ]);
    for (const old of ids) expect(msgs.some((m) => m.id === old)).toBe(false);
    expect(res.headers.get("X-User-Message-Id")).toBe(msgs[0].id);

    // The model only ever sees the edited branch.
    const sent = JSON.stringify(state.providerCalls[0]!.history);
    expect(sent).toContain("with a simple example");
    expect(sent).not.toContain("stale");
    expect(sent).not.toContain("chunking");
  });

  it("keeps everything BEFORE the edited message", async () => {
    const { conversationId, ids } = seed(ALICE, [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
      { role: "assistant", content: "stale a2" },
    ]);
    await readEvents(await post({ conversationId, editMessageId: ids[2], content: "q2 edited" }));
    expect(messagesOf(conversationId).map((m) => m.content)).toEqual(["q1", "a1", "q2 edited", "Hello world"]);
    expect(messagesOf(conversationId)[0].id).toBe(ids[0]);
    expect(messagesOf(conversationId)[1].id).toBe(ids[1]);
  });

  it("does not allow editing an assistant message", async () => {
    const { conversationId, ids } = seed(ALICE, [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" },
    ]);
    const res = await post({ conversationId, editMessageId: ids[1], content: "forged assistant text" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/only your own messages/i);
    expect(messagesOf(conversationId).map((m) => m.content)).toEqual(["q", "a"]);
    expect(state.providerCalls).toHaveLength(0);
  });

  it("cannot edit a message in another user's conversation", async () => {
    const { conversationId, ids } = seed(BOB, [
      { role: "user", content: "bob's question" },
      { role: "assistant", content: "bob's answer" },
    ]);
    const res = await post({ conversationId, editMessageId: ids[0], content: "hijacked" }); // caller is ALICE
    expect(res.status).toBe(404);
    expect(messagesOf(conversationId).map((m) => m.content)).toEqual(["bob's question", "bob's answer"]);
    expect(state.providerCalls).toHaveLength(0);
  });

  it("cannot edit another user's message by pairing it with the caller's own conversation id", async () => {
    const mine = seed(ALICE, [{ role: "user", content: "mine" }]);
    const theirs = seed(BOB, [
      { role: "user", content: "theirs" },
      { role: "assistant", content: "theirs-a" },
    ]);
    const res = await post({ conversationId: mine.conversationId, editMessageId: theirs.ids[0], content: "hijack" });
    expect(res.status).toBe(400);
    expect(messagesOf(theirs.conversationId).map((m) => m.content)).toEqual(["theirs", "theirs-a"]);
    expect(messagesOf(mine.conversationId).map((m) => m.content)).toEqual(["mine"]);
  });

  it("rejects an edit with empty or oversized content", async () => {
    const { conversationId, ids } = seed(ALICE, [{ role: "user", content: "q" }]);
    expect((await post({ conversationId, editMessageId: ids[0], content: "   " })).status).toBe(400);
    expect((await post({ conversationId, editMessageId: ids[0], content: "x".repeat(4001) })).status).toBe(400);
    expect(messagesOf(conversationId).map((m) => m.content)).toEqual(["q"]);
  });

  it("rolls back completely if the stale tail can't be removed (no duplicates, nothing lost)", async () => {
    const { conversationId, ids } = seed(ALICE, [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
    db.failures.push({ table: "messages", op: "delete", when: (c) => c.filters.includes("gte") });

    const res = await post({ conversationId, editMessageId: ids[0], content: "q1 edited" });
    expect(res.status).toBe(500);
    expect((await res.json()).code).toBe("database_error");

    const msgs = messagesOf(conversationId);
    expect(msgs.map((m) => m.content)).toEqual(["q1", "a1"]);
    expect(msgs.map((m) => m.id)).toEqual(ids);
    expect(state.providerCalls).toHaveLength(0);
  });

  it("leaves history untouched if saving the edit fails", async () => {
    const { conversationId } = seed(ALICE, [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ]);
    const original = messagesOf(conversationId)[0].id;
    db.failures.push({ table: "messages", op: "insert" });
    const res = await post({ conversationId, editMessageId: original, content: "q1 edited" });
    expect(res.status).toBe(500);
    expect(messagesOf(conversationId).map((m) => m.content)).toEqual(["q1", "a1"]);
  });

  it("carries the document attachment onto the edited message and keeps its link", async () => {
    const docId = seedDocument(ALICE, "spec.pdf");
    const { conversationId, ids } = seed(ALICE, [
      { role: "user", content: "summarize", metadata: { documentId: docId, filename: "spec.pdf" } },
      { role: "assistant", content: "stale" },
    ]);
    link(conversationId, docId, ALICE);
    mockChunkSearch([{ id: fakeUuid(), document_id: docId, chunk_index: 0, content: "Spec text.", similarity: 0.8 }]);

    const events = await readEvents(await post({ conversationId, editMessageId: ids[0], content: "summarize in one line" }));
    const done = events.find((e) => e.type === "done");

    const edited = messagesOf(conversationId)[0];
    expect(edited.metadata).toEqual({ documentId: docId, filename: "spec.pdf" });
    expect(db.tables.conversation_documents).toHaveLength(1);
    // RAG still works after an edit, with server-derived sources.
    expect(done.sources[0]).toMatchObject({ documentId: docId, content: "Spec text." });
    expect(state.providerCalls[0]!.history.at(-1)!.parts[0]!.text).toContain("Spec text.");
  });

  it("stops grounding in documents that were attached only by removed messages", async () => {
    const keep = seedDocument(ALICE, "keep.pdf");
    const drop = seedDocument(ALICE, "drop.pdf");
    const { conversationId, ids } = seed(ALICE, [
      { role: "user", content: "about keep", metadata: { documentId: keep, filename: "keep.pdf" } },
      { role: "assistant", content: "a1" },
      { role: "user", content: "about drop", metadata: { documentId: drop, filename: "drop.pdf" } },
      { role: "assistant", content: "a2" },
    ]);
    link(conversationId, keep, ALICE);
    link(conversationId, drop, ALICE);
    mockChunkSearch([
      { id: fakeUuid(), document_id: keep, chunk_index: 0, content: "keep text", similarity: 0.9 },
      { id: fakeUuid(), document_id: drop, chunk_index: 0, content: "drop text", similarity: 0.9 },
    ]);

    // Editing the FIRST message removes the later message that attached drop.pdf.
    const events = await readEvents(await post({ conversationId, editMessageId: ids[0], content: "about keep, rephrased" }));
    const done = events.find((e) => e.type === "done");

    expect(db.tables.conversation_documents!.map((l) => l.document_id)).toEqual([keep]);
    expect(state.rpcCalls[0].filter_document_ids).toEqual([keep]);
    expect(done.sources.map((s: any) => s.documentId)).toEqual([keep]);
    expect(JSON.stringify(state.providerCalls[0]!.history)).not.toContain("drop text");
    // The documents themselves are never deleted by an edit.
    expect(db.tables.documents).toHaveLength(2);
  });

  it("keeps a document link when the edited message is the one that attached it", async () => {
    const docId = seedDocument(ALICE, "only.pdf");
    const { conversationId, ids } = seed(ALICE, [
      { role: "user", content: "about it", metadata: { documentId: docId, filename: "only.pdf" } },
      { role: "assistant", content: "a1" },
    ]);
    link(conversationId, docId, ALICE);
    await readEvents(await post({ conversationId, editMessageId: ids[0], content: "about it, rephrased" }));
    expect(db.tables.conversation_documents!.map((l) => l.document_id)).toEqual([docId]);
  });
});

// ---------------------------------------------------------------------------
describe("retry (Phase 2 behaviour + Phase 5 cleanup)", () => {
  it("still regenerates an unanswered user message", async () => {
    const { conversationId, ids } = seed(ALICE, [{ role: "user", content: "q" }]);
    const events = await readEvents(await post({ conversationId, retryMessageId: ids[0] }));
    expect(events.at(-1).type).toBe("done");
    expect(messagesOf(conversationId).map((m) => m.content)).toEqual(["q", "Hello world"]);
  });

  it("removes stale incomplete attempts so they don't reappear after a refresh", async () => {
    const { conversationId, ids } = seed(ALICE, [
      { role: "user", content: "q" },
      { role: "assistant", content: "cut off 1", status: "incomplete" },
      { role: "assistant", content: "cut off 2", status: "incomplete" },
    ]);
    await readEvents(await post({ conversationId, retryMessageId: ids[0] }));
    const msgs = messagesOf(conversationId);
    expect(msgs.map((m) => [m.content, m.status])).toEqual([
      ["q", "complete"],
      ["Hello world", "complete"],
    ]);
  });

  it("reports the persisted id of an incomplete reply so the client can act on it", async () => {
    const { conversationId, ids } = seed(ALICE, [{ role: "user", content: "q" }]);
    state.failAfterChunks = true;
    const events = await readEvents(await post({ conversationId, retryMessageId: ids[0] }));
    const err = events.find((e) => e.type === "error");
    expect(err.partial).toBe(true);
    const stored = messagesOf(conversationId).find((m) => m.role === "assistant")!;
    expect(stored.status).toBe("incomplete");
    expect(err.messageId).toBe(stored.id);
  });
});
