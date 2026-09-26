import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, fakeUuid, nextTimestamp, type FakeDb } from "@/lib/testing/fake-supabase";

const state = vi.hoisted(() => ({ client: null as any }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { deleteAllMyData } from "@/app/(app)/settings/actions";

const ALICE = "aaaaaaaa-0000-4000-8000-000000000001";
const BOB = "bbbbbbbb-0000-4000-8000-000000000002";

let db: FakeDb;

function useUser(id: string | null) {
  const fake = createFakeSupabase({ userId: id });
  db = fake.db;
  state.client = fake.client;
  // The fake table builder doesn't model Storage — deleteAllMyData calls
  // supabase.storage.from(...).remove(...) as a best-effort side effect,
  // so give it a harmless stub.
  (state.client as any).storage = { from: () => ({ remove: async () => ({ error: null }) }) };
}

function seedConversation(owner: string) {
  const id = fakeUuid();
  db.tables.conversations!.push({ id, user_id: owner, title: "T", created_at: nextTimestamp(), updated_at: nextTimestamp() });
  return id;
}

function seedDocument(owner: string, storagePath: string | null = null) {
  const id = fakeUuid();
  db.tables.documents!.push({
    id,
    user_id: owner,
    filename: "f.txt",
    storage_path: storagePath,
    extraction_status: "ready",
    created_at: nextTimestamp(),
  });
  return id;
}

const confirmedForm = () => {
  const fd = new FormData();
  fd.set("confirm", "DELETE");
  return fd;
};

beforeEach(() => useUser(ALICE));

describe("deleteAllMyData", () => {
  it("requires the typed confirmation phrase", async () => {
    const fd = new FormData();
    fd.set("confirm", "delete"); // wrong case / not the exact phrase
    const result = await deleteAllMyData({ error: null, success: false }, fd);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/DELETE/);
  });

  it("requires authentication", async () => {
    useUser(null);
    const result = await deleteAllMyData({ error: null, success: false }, confirmedForm());
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/signed in/);
  });

  it("deletes only the caller's own conversations and documents, never another user's", async () => {
    seedConversation(ALICE);
    seedConversation(ALICE);
    seedDocument(ALICE);
    const bobConvo = seedConversation(BOB);
    const bobDoc = seedDocument(BOB);

    const result = await deleteAllMyData({ error: null, success: false }, confirmedForm());

    expect(result.success).toBe(true);
    expect(result.deletedConversations).toBe(2);
    expect(result.deletedDocuments).toBe(1);
    expect(db.tables.conversations).toEqual([expect.objectContaining({ id: bobConvo })]);
    expect(db.tables.documents).toEqual([expect.objectContaining({ id: bobDoc })]);
  });

  it("leaves data untouched when nothing exists yet (reports zero, not an error)", async () => {
    const result = await deleteAllMyData({ error: null, success: false }, confirmedForm());
    expect(result.success).toBe(true);
    expect(result.deletedConversations).toBe(0);
    expect(result.deletedDocuments).toBe(0);
  });

  it("attempts to remove storage objects for documents that have a storage_path", async () => {
    seedDocument(ALICE, "alice-user-id/doc-1/notes.pdf");
    const remove = vi.fn().mockResolvedValue({ error: null });
    (state.client as any).storage = { from: () => ({ remove }) };

    await deleteAllMyData({ error: null, success: false }, confirmedForm());

    expect(remove).toHaveBeenCalledWith(["alice-user-id/doc-1/notes.pdf"]);
  });
});
