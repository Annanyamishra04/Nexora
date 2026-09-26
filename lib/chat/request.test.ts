import { describe, expect, it } from "vitest";
import { buildChatRequestBody, isPersistedId, makeTempId } from "@/lib/chat/request";
import { chatRequestSchema } from "@/lib/validation/chat";

const C = "22222222-2222-4222-8222-222222222222";
const M = "11111111-1111-4111-8111-111111111111";
const D = "33333333-3333-4333-8333-333333333333";

describe("buildChatRequestBody always produces a schema-valid request", () => {
  it.each([
    ["send (new conversation)", null, { kind: "send", content: "hi" } as const],
    ["send with document", C, { kind: "send", content: "hi", documentId: D } as const],
    ["retry", C, { kind: "retry", messageId: M } as const],
    ["regenerate", C, { kind: "regenerate", messageId: M } as const],
    ["edit", C, { kind: "edit", messageId: M, content: "new text" } as const],
  ])("%s", (_name, conversationId, action) => {
    expect(chatRequestSchema.safeParse(buildChatRequestBody(conversationId, action)).success).toBe(true);
  });
  it("uses the correct field per action", () => {
    expect(buildChatRequestBody(C, { kind: "regenerate", messageId: M })).toEqual({ conversationId: C, regenerateMessageId: M });
    expect(buildChatRequestBody(C, { kind: "edit", messageId: M, content: "x" })).toEqual({ conversationId: C, editMessageId: M, content: "x" });
  });
});

describe("temp ids", () => {
  it("are unique and never mistaken for persisted ids", () => {
    const a = makeTempId();
    expect(a).not.toBe(makeTempId());
    expect(isPersistedId(a)).toBe(false);
    expect(isPersistedId(M)).toBe(true);
  });
});
