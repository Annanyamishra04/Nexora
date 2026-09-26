import { describe, expect, it } from "vitest";
import { chatRequestSchema, MAX_MESSAGE_LENGTH } from "@/lib/validation/chat";

describe("chatRequestSchema", () => {
  it("accepts a plain new message with no conversation yet", () => {
    const result = chatRequestSchema.safeParse({ content: "Hello there" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty message", () => {
    const result = chatRequestSchema.safeParse({ content: "   " });
    expect(result.success).toBe(false);
  });

  it("rejects a message with no content and no retryMessageId", () => {
    const result = chatRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects an oversized message", () => {
    const result = chatRequestSchema.safeParse({ content: "a".repeat(MAX_MESSAGE_LENGTH + 1) });
    expect(result.success).toBe(false);
  });

  it("accepts a message exactly at the limit", () => {
    const result = chatRequestSchema.safeParse({ content: "a".repeat(MAX_MESSAGE_LENGTH) });
    expect(result.success).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    const result = chatRequestSchema.safeParse({ content: "  hi  " });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.content).toBe("hi");
  });

  it("rejects both content and retryMessageId together", () => {
    const result = chatRequestSchema.safeParse({
      content: "hi",
      retryMessageId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
    });
    expect(result.success).toBe(false);
  });

  it("rejects retryMessageId without a conversationId", () => {
    const result = chatRequestSchema.safeParse({
      retryMessageId: "11111111-1111-1111-1111-111111111111",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a valid retry request", () => {
    const result = chatRequestSchema.safeParse({
      retryMessageId: "11111111-1111-1111-1111-111111111111",
      conversationId: "22222222-2222-2222-2222-222222222222",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed conversationId", () => {
    const result = chatRequestSchema.safeParse({ content: "hi", conversationId: "not-a-uuid" });
    expect(result.success).toBe(false);
  });
});

describe("chatRequestSchema — Phase 5 modes", () => {
  const C = "22222222-2222-4222-8222-222222222222";
  const M = "11111111-1111-4111-8111-111111111111";
  const ok = (v: unknown) => chatRequestSchema.safeParse(v).success;

  it("accepts regenerate and edit requests", () => {
    expect(ok({ conversationId: C, regenerateMessageId: M })).toBe(true);
    expect(ok({ conversationId: C, editMessageId: M, content: "new" })).toBe(true);
  });
  it("requires content for edit, forbids it for regenerate", () => {
    expect(ok({ conversationId: C, editMessageId: M })).toBe(false);
    expect(ok({ conversationId: C, regenerateMessageId: M, content: "x" })).toBe(false);
  });
  it("requires a conversationId for regenerate/edit", () => {
    expect(ok({ regenerateMessageId: M })).toBe(false);
    expect(ok({ editMessageId: M, content: "x" })).toBe(false);
  });
  it("rejects combining target ids or adding documentId", () => {
    expect(ok({ conversationId: C, regenerateMessageId: M, retryMessageId: M })).toBe(false);
    expect(ok({ conversationId: C, editMessageId: M, regenerateMessageId: M, content: "x" })).toBe(false);
    expect(ok({ conversationId: C, editMessageId: M, content: "x", documentId: M })).toBe(false);
  });
  it("rejects malformed ids", () => {
    expect(ok({ conversationId: C, regenerateMessageId: "nope" })).toBe(false);
  });
});
