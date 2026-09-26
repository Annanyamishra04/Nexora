import { GoogleGenAI } from "@google/genai";
import { documentError } from "@/lib/documents/errors";
import { mapEmbeddingError } from "@/lib/rag/errors";
import { EMBEDDING_BATCH_SIZE, EMBEDDING_DIMENSIONS, GEMINI_EMBEDDING_MODEL } from "@/lib/rag/config";

export type EmbeddingTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

/**
 * Server-side only: reads GEMINI_API_KEY, never touched by client code
 * (same posture as lib/ai/gemini.ts — this file must never be imported
 * from a "use client" component).
 */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embedText(text: string, taskType: EmbeddingTaskType): Promise<number[]>;
  embedTexts(texts: string[], taskType: EmbeddingTaskType): Promise<number[][]>;
}

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw documentError(
      "embedding_failed",
      "GEMINI_API_KEY is not set. Add it to your environment to enable document processing."
    );
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

/**
 * gemini-embedding-001's non-default-dimension output is NOT pre-normalized
 * by the API (unlike gemini-embedding-2, which auto-normalizes truncated
 * dimensions) — Google's docs explicitly call out manual L2 normalization
 * as required in this case. Cosine similarity is scale-invariant so this
 * wouldn't change *ranking* on its own, but it keeps stored vectors at a
 * predictable, comparable magnitude (useful if a distance metric or a
 * future model migration ever needs it) and matches documented guidance
 * exactly rather than relying on an implementation detail. Idempotent and
 * a no-op on an already-normalized or zero vector.
 */
function l2Normalize(vector: number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  if (!Number.isFinite(norm) || norm === 0) return vector;
  return vector.map((value) => value / norm);
}

function validateEmbedding(values: number[] | undefined, dimensions: number): number[] {
  if (!values || values.length === 0) {
    throw documentError("embedding_failed", "The embedding provider returned an empty embedding.");
  }
  if (values.length !== dimensions) {
    throw documentError(
      "embedding_failed",
      `The embedding provider returned a ${values.length}-dimension vector; expected ${dimensions}.`
    );
  }
  if (values.some((v) => !Number.isFinite(v))) {
    throw documentError("embedding_failed", "The embedding provider returned a malformed embedding.");
  }
  return values;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

/**
 * gemini-embedding-2's aggregation behavior (one embedding for multiple
 * inputs unless each is wrapped in its own Content) makes it a worse fit
 * for "batch of independent chunks -> one vector each" than
 * gemini-embedding-001. Both models are supported by this provider via
 * GEMINI_EMBEDDING_MODEL, but only gemini-embedding-001's task_type /
 * per-string-batching behavior is exercised by embedTexts below — see
 * docs/ARCHITECTURE.md "Embedding provider (Phase 4)" if switching models.
 */
function isGeminiEmbedding001(model: string): boolean {
  return model === "gemini-embedding-001" || model.startsWith("gemini-embedding-001");
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly model = GEMINI_EMBEDDING_MODEL;
  readonly dimensions = EMBEDDING_DIMENSIONS;

  async embedText(text: string, taskType: EmbeddingTaskType): Promise<number[]> {
    const [embedding] = await this.embedTexts([text], taskType);
    if (!embedding) {
      throw documentError("embedding_failed", "The embedding provider returned no embeddings.");
    }
    return embedding;
  }

  async embedTexts(texts: string[], taskType: EmbeddingTaskType): Promise<number[][]> {
    if (texts.length === 0) return [];

    const ai = getClient();
    const batches = chunkArray(texts, EMBEDDING_BATCH_SIZE);
    const results: number[][] = [];

    for (const batch of batches) {
      try {
        const response = await ai.models.embedContent({
          model: this.model,
          contents: batch,
          config: {
            outputDimensionality: this.dimensions,
            ...(isGeminiEmbedding001(this.model) ? { taskType } : {}),
          },
        });

        const embeddings = response.embeddings ?? [];
        if (embeddings.length !== batch.length) {
          throw documentError(
            "embedding_failed",
            `The embedding provider returned ${embeddings.length} embeddings for a batch of ${batch.length} inputs.`
          );
        }

        for (const embedding of embeddings) {
          const validated = validateEmbedding(embedding.values, this.dimensions);
          const normalized = isGeminiEmbedding001(this.model) ? l2Normalize(validated) : validated;
          results.push(normalized);
        }
      } catch (error) {
        throw mapEmbeddingError(error);
      }
    }

    return results;
  }
}
