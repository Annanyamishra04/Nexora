import { describe, expect, it, vi } from "vitest";
import { processDocumentEmbeddings } from "@/lib/rag/pipeline";
import type { EmbeddingProvider } from "@/lib/rag/embedding-provider";

const DOC_ID = "22222222-2222-2222-2222-222222222222";
const USER_ID = "11111111-1111-1111-1111-111111111111";

interface FakeOptions {
  deleteError?: { message: string } | null;
  insertError?: { message: string } | null;
  updateError?: { message: string } | null;
}

function createFakeSupabase(options: FakeOptions = {}) {
  const deletes: { table: string }[] = [];
  const inserts: { table: string; rows: Record<string, unknown>[] }[] = [];
  const updates: { table: string; payload: Record<string, unknown> }[] = [];

  function from(table: string) {
    return {
      delete: () => ({
        eq: async () => {
          deletes.push({ table });
          return { error: options.deleteError ?? null };
        },
      }),
      insert: async (rows: Record<string, unknown>[]) => {
        inserts.push({ table, rows });
        return { error: options.insertError ?? null };
      },
      update: (payload: Record<string, unknown>) => ({
        eq: async () => {
          updates.push({ table, payload });
          return { error: options.updateError ?? null };
        },
      }),
    };
  }

  return { client: { from }, deletes, inserts, updates };
}

function fakeProvider(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    model: "gemini-embedding-001",
    dimensions: 4,
    embedText: vi.fn(),
    embedTexts: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4])),
    ...overrides,
  };
}

const baseInput = {
  documentId: DOC_ID,
  userId: USER_ID,
  filename: "notes.txt",
  contentType: "text/plain",
};

describe("processDocumentEmbeddings", () => {
  it("chunks, embeds, and stores chunks, then marks the document ready", async () => {
    const { client, inserts, updates } = createFakeSupabase();
    const provider = fakeProvider();

    const result = await processDocumentEmbeddings(
      client as never,
      { ...baseInput, text: "First paragraph of real content.\n\nSecond paragraph of real content." },
      provider
    );

    expect(result.ok).toBe(true);
    expect(result.chunkCount).toBeGreaterThan(0);

    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.table).toBe("document_chunks");
    for (const row of inserts[0]!.rows) {
      expect(row.document_id).toBe(DOC_ID);
      expect(row.user_id).toBe(USER_ID);
      expect((row.metadata as { filename: string }).filename).toBe("notes.txt");
      expect(Array.isArray(row.embedding)).toBe(true);
    }

    const readyUpdate = updates.find((u) => u.payload.extraction_status === "ready");
    expect(readyUpdate).toBeTruthy();
    expect(readyUpdate!.payload.chunk_count).toBe(result.chunkCount);
    expect(readyUpdate!.payload.embedding_model).toBe(provider.model);
    expect(readyUpdate!.payload.embedding_dimensions).toBe(provider.dimensions);
    expect(readyUpdate!.payload.processing_error).toBeNull();
  });

  it("clears any existing chunks before writing new ones (idempotent reprocessing)", async () => {
    const { client, deletes } = createFakeSupabase();
    await processDocumentEmbeddings(client as never, { ...baseInput, text: "Some content here." }, fakeProvider());

    expect(deletes.some((d) => d.table === "document_chunks")).toBe(true);
  });

  it("marks the document failed (not ready, not partially ready) when there is nothing to chunk", async () => {
    const { client, updates, inserts } = createFakeSupabase();

    const result = await processDocumentEmbeddings(client as never, { ...baseInput, text: "   " }, fakeProvider());

    expect(result.ok).toBe(false);
    expect(inserts).toHaveLength(0);
    const failedUpdate = updates.find((u) => u.payload.extraction_status === "failed");
    expect(failedUpdate).toBeTruthy();
    expect(failedUpdate!.payload.chunk_count).toBe(0);
    expect(typeof failedUpdate!.payload.processing_error).toBe("string");
  });

  it("marks the document failed with a safe message when the embedding provider throws", async () => {
    const { client, updates, inserts } = createFakeSupabase();
    const provider = fakeProvider({
      embedTexts: vi.fn().mockRejectedValue(new Error("429 quota exceeded")),
    });

    const result = await processDocumentEmbeddings(client as never, { ...baseInput, text: "Real content here." }, provider);

    expect(result.ok).toBe(false);
    expect(inserts).toHaveLength(0);
    const failedUpdate = updates.find((u) => u.payload.extraction_status === "failed");
    expect(failedUpdate).toBeTruthy();
    // The raw provider error message must never leak to the stored/user-facing field.
    expect(String(failedUpdate!.payload.processing_error)).not.toContain("429");
  });

  it("cleans up partially-inserted chunks and fails safely when storing chunks errors", async () => {
    const { client, deletes, updates } = createFakeSupabase({ insertError: { message: "db down" } });

    const result = await processDocumentEmbeddings(client as never, { ...baseInput, text: "Real content here." }, fakeProvider());

    expect(result.ok).toBe(false);
    // Once for the pre-clear, once for the post-insert-failure cleanup.
    expect(deletes.filter((d) => d.table === "document_chunks").length).toBeGreaterThanOrEqual(2);
    expect(updates.some((u) => u.payload.extraction_status === "failed")).toBe(true);
  });

  it("does not mark the document ready if updating its status fails, even though chunks were stored", async () => {
    const { client, updates } = createFakeSupabase({ updateError: { message: "db down" } });

    const result = await processDocumentEmbeddings(client as never, { ...baseInput, text: "Real content here." }, fakeProvider());

    expect(result.ok).toBe(false);
    // The failed attempt is still recorded (a genuine call was made), but
    // it must be followed by an explicit 'failed' update — the document
    // is never left claiming 'ready' as the pipeline's final word.
    const lastUpdate = updates[updates.length - 1]!;
    expect(lastUpdate.payload.extraction_status).toBe("failed");
  });

  it("fails safely when the provider returns a mismatched number of embeddings", async () => {
    const { client, updates } = createFakeSupabase();
    const provider = fakeProvider({
      embedTexts: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3, 0.4]]), // always 1, regardless of chunk count
    });

    // Long enough (several large paragraphs) to force more than one chunk,
    // so the provider's fixed-length-1 response is a genuine mismatch.
    const longText = Array.from({ length: 6 }, (_, i) =>
      Array.from({ length: 400 }, (_, w) => `${i}word${w}`).join(" ")
    ).join("\n\n");

    const result = await processDocumentEmbeddings(client as never, { ...baseInput, text: longText }, provider);

    expect(result.ok).toBe(false);
    expect(updates.some((u) => u.payload.extraction_status === "failed")).toBe(true);
  });

  it("propagates a failure when clearing previous chunks fails, without calling the embedding provider", async () => {
    const { client, updates } = createFakeSupabase({ deleteError: { message: "db down" } });
    const provider = fakeProvider();

    const result = await processDocumentEmbeddings(client as never, { ...baseInput, text: "Real content here." }, provider);

    expect(result.ok).toBe(false);
    expect(provider.embedTexts).not.toHaveBeenCalled();
    expect(updates.some((u) => u.payload.extraction_status === "failed")).toBe(true);
  });
});
