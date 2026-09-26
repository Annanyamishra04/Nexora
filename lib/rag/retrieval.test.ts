import { describe, expect, it, vi } from "vitest";
import { getRetrievableDocuments, retrieveRelevantChunks } from "@/lib/rag/retrieval";
import type { EmbeddingProvider } from "@/lib/rag/embedding-provider";

const CONVO_ID = "33333333-3333-3333-3333-333333333333";
const DOC_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const DOC_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const DOC_C_NOT_ATTACHED = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function fakeProvider(overrides: Partial<EmbeddingProvider> = {}): EmbeddingProvider {
  return {
    model: "gemini-embedding-001",
    dimensions: 4,
    embedText: vi.fn(async () => [0.1, 0.2, 0.3, 0.4]),
    embedTexts: vi.fn(),
    ...overrides,
  };
}

describe("getRetrievableDocuments", () => {
  it("returns an empty list when the conversation has no attached documents", async () => {
    const client = {
      from: (table: string) => {
        if (table === "conversation_documents") {
          return { select: () => ({ eq: async () => ({ data: [] }) }) };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };

    const docs = await getRetrievableDocuments(client as never, CONVO_ID);
    expect(docs).toEqual([]);
  });

  it("only returns documents that are both attached and ready", async () => {
    const client = {
      from: (table: string) => {
        if (table === "conversation_documents") {
          return {
            select: () => ({
              eq: async () => ({ data: [{ document_id: DOC_A }, { document_id: DOC_B }] }),
            }),
          };
        }
        if (table === "documents") {
          return {
            select: () => ({
              eq: () => ({
                in: async () => ({ data: [{ id: DOC_A, filename: "a.pdf" }] }), // DOC_B excluded: not ready
              }),
            }),
          };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };

    const docs = await getRetrievableDocuments(client as never, CONVO_ID);
    expect(docs).toEqual([{ id: DOC_A, filename: "a.pdf" }]);
  });
});

describe("retrieveRelevantChunks", () => {
  it("does not attempt retrieval (and never embeds the query) when there are no eligible documents", async () => {
    const provider = fakeProvider();
    const client = { rpc: vi.fn() };

    const result = await retrieveRelevantChunks(client as never, { documents: [], query: "what?" }, provider);

    expect(result).toEqual({ attempted: false, chunks: [] });
    expect(provider.embedText).not.toHaveBeenCalled();
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("embeds the query with RETRIEVAL_QUERY and calls match_document_chunks scoped to the given documents", async () => {
    const provider = fakeProvider();
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const client = { rpc };

    await retrieveRelevantChunks(
      client as never,
      { documents: [{ id: DOC_A, filename: "a.pdf" }], query: "what is in the doc?" },
      provider
    );

    expect(provider.embedText).toHaveBeenCalledWith("what is in the doc?", "RETRIEVAL_QUERY");
    expect(rpc).toHaveBeenCalledWith(
      "match_document_chunks",
      expect.objectContaining({ filter_document_ids: [DOC_A] })
    );
  });

  it("filters out chunks below the similarity threshold", async () => {
    const provider = fakeProvider();
    const client = {
      rpc: vi.fn().mockResolvedValue({
        data: [
          { id: "c1", document_id: DOC_A, chunk_index: 0, content: "relevant", metadata: {}, similarity: 0.9 },
          { id: "c2", document_id: DOC_A, chunk_index: 1, content: "irrelevant", metadata: {}, similarity: 0.01 },
        ],
        error: null,
      }),
    };

    const result = await retrieveRelevantChunks(
      client as never,
      { documents: [{ id: DOC_A, filename: "a.pdf" }], query: "q" },
      provider
    );

    expect(result.attempted).toBe(true);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]!.chunkId).toBe("c1");
  });

  it("drops any chunk whose document isn't in the requested set, even if returned by the RPC", async () => {
    const provider = fakeProvider();
    const client = {
      rpc: vi.fn().mockResolvedValue({
        data: [
          {
            id: "c1",
            document_id: DOC_C_NOT_ATTACHED,
            chunk_index: 0,
            content: "sneaky",
            metadata: {},
            similarity: 0.99,
          },
        ],
        error: null,
      }),
    };

    const result = await retrieveRelevantChunks(
      client as never,
      { documents: [{ id: DOC_A, filename: "a.pdf" }], query: "q" },
      provider
    );

    expect(result.chunks).toEqual([]);
  });

  it("stops adding chunks once the total context character budget is spent", async () => {
    const provider = fakeProvider();
    // Each chunk's stored content is well over the per-chunk cap
    // (RAG_MAX_CHARS_PER_CHUNK), so after truncation each contributes a
    // fixed, sizeable amount toward RAG_MAX_CONTEXT_CHARS. Four such
    // chunks guarantees the total budget is exhausted before all of them
    // fit, regardless of the exact configured defaults.
    const bigContent = "x".repeat(20000);
    const client = {
      rpc: vi.fn().mockResolvedValue({
        data: [
          { id: "c1", document_id: DOC_A, chunk_index: 0, content: bigContent, metadata: {}, similarity: 0.9 },
          { id: "c2", document_id: DOC_A, chunk_index: 1, content: bigContent, metadata: {}, similarity: 0.85 },
          { id: "c3", document_id: DOC_A, chunk_index: 2, content: bigContent, metadata: {}, similarity: 0.8 },
          { id: "c4", document_id: DOC_A, chunk_index: 3, content: bigContent, metadata: {}, similarity: 0.75 },
          { id: "c5", document_id: DOC_A, chunk_index: 4, content: bigContent, metadata: {}, similarity: 0.7 },
        ],
        error: null,
      }),
    };

    const result = await retrieveRelevantChunks(
      client as never,
      { documents: [{ id: DOC_A, filename: "a.pdf" }], query: "q" },
      provider
    );

    const totalChars = result.chunks.reduce((sum, c) => sum + c.content.length, 0);
    expect(result.chunks.length).toBeLessThan(5);
    expect(totalChars).toBeGreaterThan(0);
  });

  it("returns no chunks (without throwing) when the RPC call itself errors", async () => {
    const provider = fakeProvider();
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "db down" } }) };

    const result = await retrieveRelevantChunks(
      client as never,
      { documents: [{ id: DOC_A, filename: "a.pdf" }], query: "q" },
      provider
    );

    expect(result).toEqual({ attempted: true, chunks: [] });
  });

  it("propagates a mapped, safe error when embedding the query fails", async () => {
    const provider = fakeProvider({
      embedText: vi.fn().mockRejectedValue(new Error("401 invalid api key")),
    });
    const client = { rpc: vi.fn() };

    await expect(
      retrieveRelevantChunks(client as never, { documents: [{ id: DOC_A, filename: "a.pdf" }], query: "q" }, provider)
    ).rejects.toMatchObject({ code: "embedding_failed" });
    expect(client.rpc).not.toHaveBeenCalled();
  });
});
