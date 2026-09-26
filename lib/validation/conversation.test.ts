import { describe, expect, it } from "vitest";
import {
  MAX_CONVERSATION_TITLE_LENGTH,
  normalizeTitle,
  renameConversationSchema,
  searchQuerySchema,
} from "@/lib/validation/conversation";
import { parseSnippet } from "@/lib/conversations/search";

describe("renameConversationSchema", () => {
  it("normalizes whitespace, newlines and control characters", () => {
    expect(normalizeTitle("  a \n\t b\u0000c  ")).toBe("a b c");
    expect(renameConversationSchema.parse({ title: "  Hi   there " }).title).toBe("Hi there");
  });
  it("rejects empty / whitespace-only / too long", () => {
    expect(renameConversationSchema.safeParse({ title: "  " }).success).toBe(false);
    expect(renameConversationSchema.safeParse({ title: "x".repeat(MAX_CONVERSATION_TITLE_LENGTH + 1) }).success).toBe(false);
    expect(renameConversationSchema.safeParse({ title: "x".repeat(MAX_CONVERSATION_TITLE_LENGTH) }).success).toBe(true);
  });
});

describe("searchQuerySchema", () => {
  it("trims and enforces 2–100 chars", () => {
    expect(searchQuerySchema.parse("  hi  there ")).toBe("hi there");
    expect(searchQuerySchema.safeParse("a").success).toBe(false);
    expect(searchQuerySchema.safeParse(" a ").success).toBe(false);
    expect(searchQuerySchema.safeParse("x".repeat(101)).success).toBe(false);
  });
});

describe("parseSnippet", () => {
  it("splits highlighted terms without treating text as markup", () => {
    expect(parseSnippet("see ⟦regenerate⟧ the <b>x</b>")).toEqual([
      { text: "see ", highlighted: false },
      { text: "regenerate", highlighted: true },
      { text: " the <b>x</b>", highlighted: false },
    ]);
  });
  it("degrades on unbalanced markers and empty input", () => {
    expect(parseSnippet("a ⟦b")).toEqual([{ text: "a b", highlighted: false }]);
    expect(parseSnippet(null)).toEqual([]);
    expect(parseSnippet("")).toEqual([]);
  });
});
