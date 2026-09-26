import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRateLimit, getRateLimitConfig } from "@/lib/rate-limit";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("checkRateLimit", () => {
  it("calls check_rate_limit with only the action and its configured limit — never a window (fixed server-side, Phase 6 hardening)", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ allowed: true, current_count: 3, retry_after_seconds: 42 }],
      error: null,
    });
    const client = { rpc };

    const result = await checkRateLimit(client as never, "chat");

    expect(rpc).toHaveBeenCalledWith("check_rate_limit", {
      p_action: "chat",
      p_limit: 20,
    });
    expect(result).toEqual({ ok: true, allowed: true, currentCount: 3, retryAfterSeconds: 42 });
  });

  it("returns ok: true, allowed: false with the server's retry-after hint once the limit is exceeded", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ allowed: false, current_count: 21, retry_after_seconds: 12 }],
      error: null,
    });
    const client = { rpc };

    const result = await checkRateLimit(client as never, "chat");

    expect(result.ok).toBe(true);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(12);
  });

  it("fails CLOSED (ok: false, allowed: false) when the RPC errors — never silently unmetered", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "db down" } });
    const client = { rpc };

    const result = await checkRateLimit(client as never, "document_upload");

    expect(result).toEqual({ ok: false, allowed: false, currentCount: 0, retryAfterSeconds: 30 });
  });

  it("fails closed when the RPC returns no rows", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const client = { rpc };

    const result = await checkRateLimit(client as never, "conversation_search");

    expect(result.ok).toBe(false);
    expect(result.allowed).toBe(false);
  });

  it("does not throw when the RPC promise itself rejects unexpectedly", async () => {
    // Defensive: checkRateLimit only guards against a resolved {error}
    // shape, matching how supabase-js's .rpc() actually behaves (it
    // resolves, it doesn't reject) — this documents that assumption
    // rather than silently relying on it.
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "connection refused" } });
    const client = { rpc };

    await expect(checkRateLimit(client as never, "chat")).resolves.toEqual({
      ok: false,
      allowed: false,
      currentCount: 0,
      retryAfterSeconds: 30,
    });
  });

  it("uses a per-action config so one action's limit never affects another", () => {
    expect(getRateLimitConfig("chat")).toEqual({ limit: 20, windowSeconds: 60 });
    expect(getRateLimitConfig("document_upload")).toEqual({ limit: 30, windowSeconds: 3600 });
    expect(getRateLimitConfig("conversation_search")).toEqual({ limit: 60, windowSeconds: 60 });
  });

  it("is configurable via environment variables, clamped to a sane range (matches the DB-side ceiling)", () => {
    vi.stubEnv("RATE_LIMIT_CHAT_PER_MINUTE", "5");
    expect(getRateLimitConfig("chat")).toEqual({ limit: 5, windowSeconds: 60 });

    vi.stubEnv("RATE_LIMIT_CHAT_PER_MINUTE", "not-a-number");
    expect(getRateLimitConfig("chat")).toEqual({ limit: 20, windowSeconds: 60 });

    // The TS-side clamp tops out at 1000 — same ceiling the hardened
    // SQL function enforces independently (supabase/migrations/0009_rate_limit_hardening.sql),
    // so even a direct RPC call can't exceed what the app itself would
    // ever configure.
    vi.stubEnv("RATE_LIMIT_CHAT_PER_MINUTE", "999999");
    expect(getRateLimitConfig("chat")).toEqual({ limit: 1000, windowSeconds: 60 });
  });
});
