import { describe, expect, it } from "vitest";
import { isOwnedBy, validateRetryTarget, type MinimalMessage } from "@/lib/chat/ownership";

const CONVERSATION_ID = "conv-1";

function userMessage(id: string): MinimalMessage {
  return { id, conversation_id: CONVERSATION_ID, role: "user" };
}

function assistantMessage(id: string, status: "complete" | "incomplete"): MinimalMessage {
  return { id, conversation_id: CONVERSATION_ID, role: "assistant", status };
}

describe("isOwnedBy", () => {
  it("returns false for a null row", () => {
    expect(isOwnedBy(null, "user-1")).toBe(false);
  });

  it("returns false when user_id doesn't match", () => {
    expect(isOwnedBy({ user_id: "user-2" }, "user-1")).toBe(false);
  });

  it("returns true when user_id matches", () => {
    expect(isOwnedBy({ user_id: "user-1" }, "user-1")).toBe(true);
  });
});

describe("validateRetryTarget", () => {
  it("fails when the target message doesn't exist", () => {
    const result = validateRetryTarget({
      targetMessage: null,
      messagesAfterTarget: [],
      conversationId: CONVERSATION_ID,
    });
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("fails when the target belongs to a different conversation", () => {
    const result = validateRetryTarget({
      targetMessage: { id: "m1", conversation_id: "other-conv", role: "user" },
      messagesAfterTarget: [],
      conversationId: CONVERSATION_ID,
    });
    expect(result).toEqual({ ok: false, reason: "wrong_conversation" });
  });

  it("fails when the target is not a user message", () => {
    const result = validateRetryTarget({
      targetMessage: assistantMessage("m1", "incomplete"),
      messagesAfterTarget: [],
      conversationId: CONVERSATION_ID,
    });
    expect(result).toEqual({ ok: false, reason: "not_a_user_message" });
  });

  it("succeeds when the user message has no reply yet", () => {
    const result = validateRetryTarget({
      targetMessage: userMessage("m1"),
      messagesAfterTarget: [],
      conversationId: CONVERSATION_ID,
    });
    expect(result).toEqual({ ok: true });
  });

  it("succeeds when every prior attempt was incomplete", () => {
    const result = validateRetryTarget({
      targetMessage: userMessage("m1"),
      messagesAfterTarget: [assistantMessage("m2", "incomplete"), assistantMessage("m3", "incomplete")],
      conversationId: CONVERSATION_ID,
    });
    expect(result).toEqual({ ok: true });
  });

  it("fails once a complete assistant reply exists", () => {
    const result = validateRetryTarget({
      targetMessage: userMessage("m1"),
      messagesAfterTarget: [assistantMessage("m2", "complete")],
      conversationId: CONVERSATION_ID,
    });
    expect(result).toEqual({ ok: false, reason: "already_answered" });
  });

  it("fails when a newer user message already followed (conversation moved on)", () => {
    const result = validateRetryTarget({
      targetMessage: userMessage("m1"),
      messagesAfterTarget: [userMessage("m2")],
      conversationId: CONVERSATION_ID,
    });
    expect(result).toEqual({ ok: false, reason: "already_answered" });
  });
});

// ---------------------------------------------------------------------------
// Phase 5
// ---------------------------------------------------------------------------
import {
  findStaleDocumentIds,
  validateEditTarget,
  validateRegenerateTarget,
  type StoredMessage,
} from "@/lib/chat/ownership";

function stored(id: string, role: "user" | "assistant", userId = "u1", conversationId = CONVERSATION_ID): StoredMessage {
  return { id, conversation_id: conversationId, user_id: userId, role, content: id, created_at: "2026-01-01T00:00:00Z" };
}

describe("validateRegenerateTarget", () => {
  const args = (over: Partial<Parameters<typeof validateRegenerateTarget>[0]> = {}) => ({
    targetId: "a1",
    latestMessages: [stored("a1", "assistant"), stored("q1", "user")],
    conversationId: CONVERSATION_ID,
    userId: "u1",
    ...over,
  });

  it("accepts the latest assistant reply and returns the user message it answers", () => {
    const r = validateRegenerateTarget(args());
    expect(r.ok && r.userMessage.id).toBe("q1");
  });
  it.each([
    ["nothing in the conversation", { latestMessages: [] }, "not_found"],
    ["not the latest message", { targetId: "older" }, "not_latest"],
    ["a user message", { targetId: "q1", latestMessages: [stored("q1", "user")] }, "not_an_assistant_message"],
    ["another user's message", { latestMessages: [stored("a1", "assistant", "u2"), stored("q1", "user", "u2")] }, "not_owner"],
    ["another conversation", { latestMessages: [stored("a1", "assistant", "u1", "other"), stored("q1", "user")] }, "wrong_conversation"],
    ["no preceding user message", { latestMessages: [stored("a1", "assistant")] }, "no_user_message"],
    ["preceding message is an assistant", { latestMessages: [stored("a1", "assistant"), stored("a0", "assistant")] }, "no_user_message"],
  ])("rejects %s", (_n, over, reason) => {
    expect(validateRegenerateTarget(args(over as never))).toEqual({ ok: false, reason });
  });
});

describe("validateEditTarget", () => {
  it("accepts the caller's own user message", () => {
    expect(validateEditTarget({ target: stored("q1", "user"), conversationId: CONVERSATION_ID, userId: "u1" }).ok).toBe(true);
  });
  it.each([
    ["missing", null, "not_found"],
    ["an assistant message", stored("a1", "assistant"), "not_a_user_message"],
    ["someone else's message", stored("q1", "user", "u2"), "not_owner"],
    ["another conversation's message", stored("q1", "user", "u1", "other"), "wrong_conversation"],
  ])("rejects %s", (_n, target, reason) => {
    expect(validateEditTarget({ target, conversationId: CONVERSATION_ID, userId: "u1" })).toEqual({ ok: false, reason });
  });
});

describe("findStaleDocumentIds", () => {
  it("returns links no remaining message justifies", () => {
    expect(findStaleDocumentIds(["d1", "d2"], [{ documentId: "d1", filename: "a" }, null, { sources: [] }])).toEqual(["d2"]);
  });
  it("returns nothing when all are still referenced, and everything when no messages remain", () => {
    expect(findStaleDocumentIds(["d1"], [{ documentId: "d1" }])).toEqual([]);
    expect(findStaleDocumentIds(["d1", "d2"], [])).toEqual(["d1", "d2"]);
  });
});
