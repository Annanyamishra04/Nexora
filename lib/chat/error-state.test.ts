import { describe, expect, it } from "vitest";
import { ChatRequestError, kindFromCode, presentError, presentNotice, presentThrown } from "@/lib/chat/error-state";

describe("error classification", () => {
  it.each([
    ["unauthenticated", "auth"],
    ["invalid_request", "validation"],
    ["not_found", "not_found"],
    ["forbidden", "not_found"],
    ["rate_limited", "rate_limit"],
    ["provider_error", "provider"],
    ["network_error", "provider"],
    ["config_error", "provider"],
    ["document_error", "document"],
    ["database_error", "unknown"],
  ])("maps code %s -> %s", (code, kind) => {
    expect(kindFromCode(code)).toBe(kind);
    expect(presentError({ code }).kind).toBe(kind);
  });

  it("falls back to HTTP status when there is no code", () => {
    expect(presentError({ status: 401 }).kind).toBe("auth");
    expect(presentError({ status: 429 }).kind).toBe("rate_limit");
    expect(presentError({ status: 422 }).kind).toBe("validation");
    expect(presentError({ status: 503 }).kind).toBe("unknown");
  });

  it("classifies browser fetch failures as network errors and never shows their raw text", () => {
    const p = presentThrown(new TypeError("Failed to fetch"));
    expect(p.kind).toBe("network");
    expect(p.message).not.toMatch(/Failed to fetch/);
    expect(p.retryable).toBe(true);
  });

  it("does not display arbitrary thrown text (e.g. JSON parse errors)", () => {
    const p = presentThrown(new SyntaxError("Unexpected token < in JSON at position 0"));
    expect(p.kind).toBe("unknown");
    expect(p.message).not.toMatch(/Unexpected token/);
  });

  it("shows the server's already-safe message for ChatRequestError", () => {
    const p = presentThrown(new ChatRequestError("Slow down.", { code: "rate_limited", status: 429 }));
    expect(p).toMatchObject({ kind: "rate_limit", message: "Slow down.", retryable: true });
  });

  it("falls back to a category default when the server message is empty", () => {
    expect(presentThrown(new ChatRequestError("", { status: 401 })).message).toMatch(/sign in/i);
  });

  it("marks auth/document/validation errors non-retryable", () => {
    for (const code of ["unauthenticated", "document_error", "invalid_request"]) {
      expect(presentError({ code }).retryable).toBe(false);
    }
  });

  it("presents the retrieval notice as its own category", () => {
    expect(presentNotice("retrieval_failed").kind).toBe("retrieval");
  });
});
