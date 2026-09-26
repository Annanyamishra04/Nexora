import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { readEnvInt } from "@/lib/env";

/**
 * Phase 6: lightweight, database-backed rate limiting, scoped to
 * authenticated users (never IP-only — see supabase/migrations/0008_rate_limits.sql
 * and 0009_rate_limit_hardening.sql for why that's safe: the RPC
 * hard-scopes every counter to auth.uid()).
 *
 * Callers must have already verified `supabase.auth.getUser()` succeeded
 * before calling this — `checkRateLimit` does not perform auth itself,
 * it only meters an already-authenticated request. A request with no
 * session fails closed (see the migration's `check_rate_limit`).
 */

export type RateLimitAction = "chat" | "document_upload" | "conversation_search";

export interface RateLimitResult {
  /**
   * Whether the rate-limit *check itself* completed successfully. When
   * false, `allowed` is always false too — see `checkRateLimit`'s doc
   * comment for why this fails closed (Phase 6 correction) rather than
   * open. Callers must check `ok` before trusting `allowed`: an `ok:
   * false` result means "the limiter is unavailable, reject/retry",
   * not "the user is over their limit".
   */
  ok: boolean;
  allowed: boolean;
  currentCount: number;
  retryAfterSeconds: number;
}

/**
 * Configurable via environment variables (documented in lib/env.ts and
 * .env.example); conservative free-tier defaults chosen to comfortably
 * cover normal interactive use (including fast local development/manual
 * testing — a person clicking around shouldn't hit these) while still
 * bounding a runaway script or a compromised session.
 *
 * `windowSeconds` here is only used for this module's own bookkeeping —
 * as of the Phase 6 hardening correction, the actual bucketing window is
 * decided server-side inside the `check_rate_limit` SQL function itself
 * (fixed per action), specifically so a caller invoking the RPC directly
 * cannot widen or shrink it. `limit` is still passed through to the RPC,
 * which clamps it to a hard ceiling (see the migration) so a caller
 * cannot request a limit any larger than the maximum this app would ever
 * legitimately configure.
 */
export function getRateLimitConfig(action: RateLimitAction): { limit: number; windowSeconds: number } {
  switch (action) {
    case "chat":
      return { limit: readEnvInt("RATE_LIMIT_CHAT_PER_MINUTE", 20, 1, 1000), windowSeconds: 60 };
    case "document_upload":
      return { limit: readEnvInt("RATE_LIMIT_UPLOAD_PER_HOUR", 30, 1, 1000), windowSeconds: 3600 };
    case "conversation_search":
      return { limit: readEnvInt("RATE_LIMIT_SEARCH_PER_MINUTE", 60, 1, 1000), windowSeconds: 60 };
  }
}

/**
 * Checks and atomically increments the caller's counter for `action` via
 * the `check_rate_limit` SQL function.
 *
 * Phase 6 correction: this now fails CLOSED, not open. An earlier
 * version returned `allowed: true` whenever the RPC errored, which meant
 * a database/RPC outage silently turned off abuse protection on every
 * protected endpoint. That was backwards for a production system: a
 * transient metering failure should degrade to "reject with a clear,
 * temporary error" (503, distinct from the 429 a real over-limit caller
 * gets), not "let every request through unmetered". Callers are
 * responsible for mapping `ok: false` to a 503 response that never
 * repeats the underlying `error.message` to the client.
 */
export async function checkRateLimit(
  supabase: SupabaseClient<Database>,
  action: RateLimitAction
): Promise<RateLimitResult> {
  const { limit } = getRateLimitConfig(action);

  const { data, error } = await supabase.rpc("check_rate_limit", {
    p_action: action,
    p_limit: limit,
  });

  if (error || !data || data.length === 0) {
    console.error(`Rate limit check failed for action "${action}":`, error?.message);
    return { ok: false, allowed: false, currentCount: 0, retryAfterSeconds: 30 };
  }

  const row = data[0]!;
  return {
    ok: true,
    allowed: row.allowed,
    currentCount: row.current_count,
    retryAfterSeconds: row.retry_after_seconds,
  };
}
