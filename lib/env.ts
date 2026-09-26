/**
 * Phase 6: centralized environment validation.
 *
 * This module is the one place that decides what's *required* vs
 * *optional* and documents the safe defaults for optional values. It
 * does not replace the existing, already-working env reads scattered
 * across lib/rag/config.ts, lib/ai/gemini.ts, lib/supabase/*.ts (those
 * are left untouched, per "don't rewrite working features") — it adds a
 * validation layer on top, used by:
 *
 *   - `instrumentation.ts`, which calls `validateServerEnv()` once per
 *     server process (Next.js's `register()` hook) so a production
 *     deployment with missing critical configuration fails loudly at
 *     boot instead of surfacing as a confusing per-request crash the
 *     first time middleware or a Server Component runs.
 *   - `lib/rate-limit.ts`, for the rate-limit env vars.
 *
 * Server-only: never imported from a "use client" component. Nothing in
 * here reads or logs the actual value of a secret — only whether it is
 * present.
 */

export interface EnvVarSpec {
  name: string;
  /** True if a missing value should fail validation in production. */
  required: boolean;
  description: string;
  /** Human-readable default, shown in error/reporting output. Empty for required vars with no safe default. */
  default?: string;
}

/**
 * Every environment variable this app reads, required or not. Kept as
 * data (not scattered `process.env` reads) so `.env.example` and the
 * README deployment guide can be checked against a single source of
 * truth, and so a production boot can validate all of them in one pass.
 *
 * NEXT_PUBLIC_-prefixed variables are the only ones ever safe to expose
 * to the browser — Next.js itself enforces this at build time by
 * inlining only that-prefixed variables into client bundles. Every
 * variable below without that prefix is server-only by construction:
 * never read it from a "use client" component or pass it as a prop into
 * one.
 */
export const ENV_SPEC: readonly EnvVarSpec[] = [
  {
    name: "NEXT_PUBLIC_SUPABASE_URL",
    required: true,
    description: "Supabase project URL. Public by design (RLS, not secrecy, protects data).",
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    required: true,
    description: "Supabase anonymous/public API key. Public by design — every request is still subject to RLS.",
  },
  {
    name: "GEMINI_API_KEY",
    required: false,
    description:
      "Server-only. Required for real AI responses and embeddings; without it, /api/chat and document upload return a clear config_error instead of crashing.",
  },
  { name: "GEMINI_MODEL", required: false, default: "gemini-flash-latest", description: "Chat model override." },
  {
    name: "GEMINI_EMBEDDING_MODEL",
    required: false,
    default: "gemini-embedding-001",
    description: "Embedding model override.",
  },
  {
    name: "GEMINI_EMBEDDING_DIMENSIONS",
    required: false,
    default: "768",
    description: "Must match the vector(768) column in supabase/migrations/0005_rag.sql if changed.",
  },
  { name: "RAG_CHUNK_MAX_CHARS", required: false, default: "1800", description: "Chunking tunable." },
  { name: "RAG_CHUNK_OVERLAP_CHARS", required: false, default: "200", description: "Chunking tunable." },
  { name: "RAG_CHUNK_MIN_CHARS", required: false, default: "200", description: "Chunking tunable." },
  { name: "RAG_EMBEDDING_BATCH_SIZE", required: false, default: "16", description: "Embedding batch size." },
  { name: "RAG_TOP_K", required: false, default: "6", description: "Retrieval tunable." },
  { name: "RAG_SIMILARITY_THRESHOLD", required: false, default: "0.5", description: "Retrieval tunable." },
  { name: "RAG_MAX_CONTEXT_CHARS", required: false, default: "6000", description: "Retrieval tunable." },
  { name: "RAG_MAX_CHARS_PER_CHUNK", required: false, default: "1800", description: "Retrieval tunable." },
  {
    name: "RATE_LIMIT_CHAT_PER_MINUTE",
    required: false,
    default: "20",
    description: "Max /api/chat requests per authenticated user per minute.",
  },
  {
    name: "RATE_LIMIT_UPLOAD_PER_HOUR",
    required: false,
    default: "30",
    description: "Max document upload/reprocess requests per authenticated user per hour.",
  },
  {
    name: "RATE_LIMIT_SEARCH_PER_MINUTE",
    required: false,
    default: "60",
    description: "Max conversation search requests per authenticated user per minute.",
  },
] as const;

export interface EnvValidationResult {
  ok: boolean;
  missingRequired: string[];
}

/**
 * Checks only presence (never logs values). Safe to call in any
 * environment; the *caller* decides whether to throw (production boot)
 * or just report (a settings-page diagnostic, a test).
 */
export function validateEnv(): EnvValidationResult {
  const missingRequired = ENV_SPEC.filter((spec) => spec.required && !process.env[spec.name]).map(
    (spec) => spec.name
  );
  return { ok: missingRequired.length === 0, missingRequired };
}

/**
 * Called once from instrumentation.ts on server boot. Throws only in
 * production — local development intentionally stays lenient (the app is
 * designed to start and show clear per-request config errors instead of
 * crashing, per the existing GEMINI_API_KEY behavior in lib/ai/gemini.ts)
 * so `npm run dev` without a .env.local doesn't hard-fail before a
 * developer has had a chance to configure anything.
 */
export function validateServerEnv(): void {
  const result = validateEnv();
  if (result.ok) return;

  const message = `Missing required environment variable(s): ${result.missingRequired.join(", ")}. See .env.example.`;

  if (process.env.NODE_ENV === "production") {
    throw new Error(message);
  }
  console.warn(`[env] ${message}`);
}

/** Read an integer env var with a fallback and inclusive clamp — same shape as lib/rag/config.ts's readInt, duplicated here to keep this module dependency-free. */
export function readEnvInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
