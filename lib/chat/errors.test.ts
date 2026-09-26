import { describe, expect, it } from "vitest";
import { ChatError, chatError, mapUnknownError } from "@/lib/chat/errors";

describe("chatError", () => {
  it("assigns the correct HTTP status per code", () => {
    expect(chatError("unauthenticated", "x").status).toBe(401);
    expect(chatError("invalid_request", "x").status).toBe(400);
    expect(chatError("not_found", "x").status).toBe(404);
    expect(chatError("forbidden", "x").status).toBe(403);
    expect(chatError("rate_limited", "x").status).toBe(429);
    expect(chatError("config_error", "x").status).toBe(500);
    expect(chatError("provider_error", "x").status).toBe(502);
    expect(chatError("network_error", "x").status).toBe(502);
    expect(chatError("database_error", "x").status).toBe(500);
  });
});

describe("mapUnknownError", () => {
  it("passes an existing ChatError through unchanged", () => {
    const original = chatError("forbidden", "nope");
    expect(mapUnknownError(original)).toBe(original);
  });

  it("maps rate-limit style errors without leaking the provider's message", () => {
    const result = mapUnknownError(new Error("429 Too Many Requests: quota exceeded for project 12345"));
    expect(result.code).toBe("rate_limited");
    expect(result.message).not.toMatch(/12345/);
  });

  it("maps network-style errors", () => {
    const result = mapUnknownError(new Error("fetch failed: ECONNRESET"));
    expect(result.code).toBe("network_error");
  });

  it("maps auth/config style errors without echoing the key", () => {
    const result = mapUnknownError(new Error("Invalid API key: AIzaSySECRET123"));
    expect(result.code).toBe("config_error");
    expect(result.message).not.toMatch(/AIzaSySECRET123/);
  });

  it("falls back to a generic provider error for anything unrecognized", () => {
    const result = mapUnknownError(new Error("some totally unexpected internal failure"));
    expect(result.code).toBe("provider_error");
    expect(result.message).not.toMatch(/unexpected internal failure/);
  });

  it("handles non-Error thrown values safely", () => {
    const result = mapUnknownError("a raw string was thrown");
    expect(result).toBeInstanceOf(ChatError);
    expect(result.message).not.toMatch(/raw string/);
  });
});
