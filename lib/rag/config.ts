/**
 * Phase 4 RAG configuration. Every tunable is env-overridable with a
 * conservative default chosen for a free-tier deployment (small document
 * counts, limited Gemini/Supabase quota) — see docs/ARCHITECTURE.md
 * "RAG configuration defaults (Phase 4)" for the reasoning behind each
 * number.
 */

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function readFloat(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Configurable per "verify current Gemini embedding API" — never
 * hardcoded elsewhere in the codebase. Defaults to the stable,
 * text-only model: gemini-embedding-2 is multimodal and, for a list of
 * plain-text chunks, aggregates them into a single embedding unless each
 * one is wrapped in its own `Content` object, which is a worse fit for
 * this app's "embed N chunks, get N vectors" batching than
 * gemini-embedding-001's native one-embedding-per-input-string behavior.
 * gemini-embedding-001 also natively supports RETRIEVAL_DOCUMENT /
 * RETRIEVAL_QUERY task types, which is exactly this app's asymmetric
 * retrieval shape. See lib/rag/embedding-provider.ts.
 */
export const GEMINI_EMBEDDING_MODEL = process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001";

/**
 * Output vector width. Both supported models use Matryoshka
 * Representation Learning and support truncating from a 3072-dimension
 * native output; Google recommends 768, 1536, or 3072. 768 is the
 * smallest recommended size — chosen to keep pgvector row/index size
 * small on a free-tier Postgres instance. MUST match the `vector(768)`
 * column width declared in supabase/migrations/0005_rag.sql — if this is
 * changed, that migration's column type must change too (see its
 * comments) via a new migration.
 */
export const EMBEDDING_DIMENSIONS = readInt("GEMINI_EMBEDDING_DIMENSIONS", 768, 128, 3072);

/** gemini-embedding-001's per-input token limit is 2,048 tokens (~8,000 characters at a rough 4-chars/token approximation) — chunk size is kept well under that. */
export const CHUNK_MAX_CHARS = readInt("RAG_CHUNK_MAX_CHARS", 1800, 400, 6000);
export const CHUNK_OVERLAP_CHARS = readInt("RAG_CHUNK_OVERLAP_CHARS", 200, 0, 1000);
/** Below this, a trailing chunk is merged into the previous one rather than stored on its own — avoids embedding near-empty fragments. */
export const CHUNK_MIN_CHARS = readInt("RAG_CHUNK_MIN_CHARS", 200, 0, 1000);

/** How many chunks are sent to Gemini in a single embedContent call. Keeps individual requests small and retryable rather than one giant batch per document. */
export const EMBEDDING_BATCH_SIZE = readInt("RAG_EMBEDDING_BATCH_SIZE", 16, 1, 100);

/**
 * Retrieval defaults. Conservative on purpose: a free-tier deployment
 * would rather under-retrieve (and have the model say "not enough
 * information") than burn context budget / Gemini tokens on marginal
 * matches. See docs/ARCHITECTURE.md "Retrieval defaults (Phase 4)".
 */
export const RAG_TOP_K = readInt("RAG_TOP_K", 6, 1, 20);
/** Cosine similarity in [-1, 1]; chunks scoring below this are dropped before ever reaching the prompt. */
export const RAG_SIMILARITY_THRESHOLD = readFloat("RAG_SIMILARITY_THRESHOLD", 0.5, -1, 1);

/** Hard ceiling on total retrieved-chunk characters placed in the prompt, independent of RAG_TOP_K — a safety net if top-K chunks happen to be unusually large. */
export const RAG_MAX_CONTEXT_CHARS = readInt("RAG_MAX_CONTEXT_CHARS", 6000, 500, 20000);
/** Per-chunk cap applied when building the prompt (defense in depth; chunks are already bounded by CHUNK_MAX_CHARS at write time). */
export const RAG_MAX_CHARS_PER_CHUNK = readInt("RAG_MAX_CHARS_PER_CHUNK", CHUNK_MAX_CHARS, 200, 6000);
