import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const embedContentMock = vi.fn();

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn().mockImplementation(() => ({
    models: { embedContent: embedContentMock },
  })),
}));

function makeEmbedding(dim: number, fill = 1): { values: number[] } {
  return { values: Array.from({ length: dim }, () => fill) };
}

describe("GeminiEmbeddingProvider", () => {
  const originalKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
    embedContentMock.mockReset();
  });

  afterEach(() => {
    process.env.GEMINI_API_KEY = originalKey;
    vi.resetModules();
  });

  it("throws a safe, mapped error when GEMINI_API_KEY is not set", async () => {
    delete process.env.GEMINI_API_KEY;
    vi.resetModules();
    const { GeminiEmbeddingProvider } = await import("@/lib/rag/embedding-provider");
    const provider = new GeminiEmbeddingProvider();

    await expect(provider.embedText("hello", "RETRIEVAL_DOCUMENT")).rejects.toMatchObject({
      code: "embedding_failed",
    });
  });

  it("returns one normalized vector per input and validates the dimension", async () => {
    vi.resetModules();
    const { GeminiEmbeddingProvider } = await import("@/lib/rag/embedding-provider");
    const provider = new GeminiEmbeddingProvider();

    embedContentMock.mockResolvedValueOnce({
      embeddings: [makeEmbedding(provider.dimensions, 3), makeEmbedding(provider.dimensions, 4)],
    });

    const [first, second] = await provider.embedTexts(["a", "b"], "RETRIEVAL_DOCUMENT");

    expect(first).toHaveLength(provider.dimensions);
    expect(second).toHaveLength(provider.dimensions);
    // L2-normalized: every component of a uniform-fill vector should be
    // the same value, and the vector's norm should be ~1.
    const norm = Math.sqrt(first!.reduce((sum, v) => sum + v * v, 0));
    expect(norm).toBeCloseTo(1, 5);
  });

  it("rejects a response with the wrong embedding dimension", async () => {
    vi.resetModules();
    const { GeminiEmbeddingProvider } = await import("@/lib/rag/embedding-provider");
    const provider = new GeminiEmbeddingProvider();

    embedContentMock.mockResolvedValueOnce({
      embeddings: [makeEmbedding(provider.dimensions - 1)],
    });

    await expect(provider.embedText("hello", "RETRIEVAL_QUERY")).rejects.toMatchObject({
      code: "embedding_failed",
    });
  });

  it("rejects a malformed embedding (NaN/Infinity values)", async () => {
    vi.resetModules();
    const { GeminiEmbeddingProvider } = await import("@/lib/rag/embedding-provider");
    const provider = new GeminiEmbeddingProvider();

    embedContentMock.mockResolvedValueOnce({
      embeddings: [{ values: Array.from({ length: provider.dimensions }, (_, i) => (i === 0 ? NaN : 1)) }],
    });

    await expect(provider.embedText("hello", "RETRIEVAL_QUERY")).rejects.toMatchObject({
      code: "embedding_failed",
    });
  });

  it("rejects a batch response whose embedding count doesn't match the input count", async () => {
    vi.resetModules();
    const { GeminiEmbeddingProvider } = await import("@/lib/rag/embedding-provider");
    const provider = new GeminiEmbeddingProvider();

    embedContentMock.mockResolvedValueOnce({
      embeddings: [makeEmbedding(provider.dimensions)],
    });

    await expect(provider.embedTexts(["a", "b"], "RETRIEVAL_DOCUMENT")).rejects.toMatchObject({
      code: "embedding_failed",
    });
  });

  it("returns an empty array for an empty input list without calling the provider", async () => {
    vi.resetModules();
    const { GeminiEmbeddingProvider } = await import("@/lib/rag/embedding-provider");
    const provider = new GeminiEmbeddingProvider();

    const result = await provider.embedTexts([], "RETRIEVAL_DOCUMENT");

    expect(result).toEqual([]);
    expect(embedContentMock).not.toHaveBeenCalled();
  });

  it("splits large inputs into multiple batched provider calls", async () => {
    vi.resetModules();
    process.env.RAG_EMBEDDING_BATCH_SIZE = "2";
    const { GeminiEmbeddingProvider } = await import("@/lib/rag/embedding-provider");
    const provider = new GeminiEmbeddingProvider();

    embedContentMock.mockImplementation(async ({ contents }: { contents: string[] }) => ({
      embeddings: contents.map(() => makeEmbedding(provider.dimensions)),
    }));

    const result = await provider.embedTexts(["a", "b", "c", "d", "e"], "RETRIEVAL_DOCUMENT");

    expect(result).toHaveLength(5);
    expect(embedContentMock).toHaveBeenCalledTimes(3); // 2 + 2 + 1
    delete process.env.RAG_EMBEDDING_BATCH_SIZE;
  });

  it("maps a rate-limit error from the provider to a retryable embedding_failed error", async () => {
    vi.resetModules();
    const { GeminiEmbeddingProvider } = await import("@/lib/rag/embedding-provider");
    const provider = new GeminiEmbeddingProvider();

    embedContentMock.mockRejectedValueOnce(new Error("429 Too Many Requests: quota exceeded"));

    await expect(provider.embedText("hello", "RETRIEVAL_DOCUMENT")).rejects.toMatchObject({
      code: "embedding_failed",
    });
  });
});
