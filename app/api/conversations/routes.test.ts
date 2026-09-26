import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, fakeUuid, nextTimestamp, type FakeDb } from "@/lib/testing/fake-supabase";

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));

import { DELETE, PATCH } from "@/app/api/conversations/[id]/route";
import { GET as SEARCH } from "@/app/api/conversations/search/route";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";
let db: FakeDb;

function useUser(id: string | null) {
  const fake = createFakeSupabase({ userId: id });
  db = fake.db;
  state.client = fake.client;
}
function seedConversation(owner: string, title = "Original") {
  const id = fakeUuid();
  db.tables.conversations!.push({ id, user_id: owner, title, created_at: nextTimestamp(), updated_at: nextTimestamp() });
  db.tables.messages!.push({ id: fakeUuid(), conversation_id: id, user_id: owner, role: "user", content: "hi", status: "complete", metadata: null, created_at: nextTimestamp() });
  return id;
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const patch = (id: string, body: unknown) =>
  PATCH(new Request("http://x", { method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body) }), ctx(id));
const del = (id: string) => DELETE(new Request("http://x", { method: "DELETE" }), ctx(id));
const search = (q?: string) =>
  SEARCH(new Request(`http://x/api/conversations/search${q === undefined ? "" : `?q=${encodeURIComponent(q)}`}`));

beforeEach(() => useUser(ALICE));

describe("PATCH rename", () => {
  it("requires authentication", async () => {
    const id = seedConversation(ALICE);
    useUser(null);
    expect((await patch(id, { title: "x" })).status).toBe(401);
  });
  it("trims and collapses whitespace", async () => {
    const id = seedConversation(ALICE);
    const res = await patch(id, { title: "  My \n  new   title  " });
    expect(res.status).toBe(200);
    expect(db.tables.conversations![0]!.title).toBe("My new title");
  });
  it.each([[""], ["   \n\t "], ["x".repeat(81)]])("rejects invalid title %#", async (title) => {
    const id = seedConversation(ALICE);
    const res = await patch(id, { title });
    expect(res.status).toBe(400);
    expect(db.tables.conversations![0]!.title).toBe("Original");
  });
  it("accepts exactly the max length", async () => {
    const id = seedConversation(ALICE);
    expect((await patch(id, { title: "x".repeat(80) })).status).toBe(200);
  });
  it("rejects non-JSON and non-string titles", async () => {
    const id = seedConversation(ALICE);
    expect((await patch(id, "{nope")).status).toBe(400);
    expect((await patch(id, { title: 42 })).status).toBe(400);
    expect((await patch(id, {})).status).toBe(400);
  });
  it("cannot rename another user's conversation (404, unchanged)", async () => {
    const id = seedConversation(BOB, "Bob's");
    const res = await patch(id, { title: "pwned" });
    expect(res.status).toBe(404);
    expect(db.tables.conversations![0]!.title).toBe("Bob's");
  });
  it("ignores a client-supplied user_id", async () => {
    const id = seedConversation(ALICE);
    await patch(id, { title: "ok", user_id: BOB });
    expect(db.tables.conversations![0]!.user_id).toBe(ALICE);
  });
  it("treats a malformed id as not found", async () => {
    expect((await patch("not-a-uuid", { title: "x" })).status).toBe(404);
  });
});

describe("DELETE", () => {
  it("requires authentication", async () => {
    const id = seedConversation(ALICE);
    useUser(null);
    expect((await del(id)).status).toBe(401);
  });
  it("cannot delete another user's conversation (404, intact)", async () => {
    const id = seedConversation(BOB);
    expect((await del(id)).status).toBe(404);
    expect(db.tables.conversations).toHaveLength(1);
    expect(db.tables.messages).toHaveLength(1);
  });
  it("deletes messages and links but never documents", async () => {
    const id = seedConversation(ALICE);
    const other = seedConversation(ALICE, "Other");
    const docId = fakeUuid();
    db.tables.documents!.push({ id: docId, user_id: ALICE, filename: "a.pdf" });
    db.tables.conversation_documents!.push(
      { conversation_id: id, document_id: docId, user_id: ALICE },
      { conversation_id: other, document_id: docId, user_id: ALICE }
    );
    expect((await del(id)).status).toBe(200);
    expect(db.tables.conversations!.map((c) => c.id)).toEqual([other]);
    expect(db.tables.messages!.every((m) => m.conversation_id === other)).toBe(true);
    expect(db.tables.conversation_documents!.map((l) => l.conversation_id)).toEqual([other]);
    expect(db.tables.documents).toHaveLength(1);
  });
  it("a second delete is a clean 404", async () => {
    const id = seedConversation(ALICE);
    await del(id);
    expect((await del(id)).status).toBe(404);
  });
  it("surfaces database failure safely", async () => {
    const id = seedConversation(ALICE);
    db.failures.push({ table: "conversations", op: "delete", message: "relation secret_table exploded" });
    const res = await del(id);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/secret_table/);
  });
});

describe("GET search", () => {
  it("requires authentication", async () => {
    useUser(null);
    expect((await search("hello")).status).toBe(401);
  });
  it("validates the query", async () => {
    expect((await search()).status).toBe(400);
    expect((await search("a")).status).toBe(400);
    expect((await search("   ")).status).toBe(400);
    expect((await search("x".repeat(101))).status).toBe(400);
  });
  it("passes only the sanitized query to the scoped RPC — never a user id", async () => {
    const calls: any[] = [];
    db.rpcHandlers.search_conversations = (args) => {
      calls.push(args);
      return {
        data: [{ id: "c1", title: "T", updated_at: "2026-01-01", match_type: "message", snippet: "a ⟦b⟧" }],
        error: null,
      };
    };
    const res = await search("  hello   world ");
    expect(res.status).toBe(200);
    expect(calls).toEqual([{ search_query: "hello world", result_limit: 20 }]);
    expect((await res.json()).results).toEqual([
      { id: "c1", title: "T", updatedAt: "2026-01-01", matchType: "message", snippet: "a ⟦b⟧" },
    ]);
  });
  it("does not leak database internals on failure", async () => {
    db.rpcHandlers.search_conversations = () => ({ data: null, error: { message: "syntax error in tsquery near secret" } });
    const res = await search("hello");
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/tsquery|secret/);
  });
  it("returns 429 with Retry-After when the caller is over the search rate limit", async () => {
    db.rpcHandlers.check_rate_limit = () => ({
      data: [{ allowed: false, current_count: 61, retry_after_seconds: 9 }],
      error: null,
    });
    const res = await search("hello");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("9");
    expect((await res.json()).code).toBe("rate_limited");
  });
  it("returns 503 (fails closed, not silently unmetered) when the rate-limit RPC fails", async () => {
    db.rpcHandlers.check_rate_limit = () => ({ data: null, error: { message: "db down" } });
    const res = await search("hello");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe("rate_limit_unavailable");
    expect(JSON.stringify(body)).not.toMatch(/db down/);
  });
});
