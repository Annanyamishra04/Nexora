import { describe, expect, it } from "vitest";
import {
  buildGeminiHistory,
  MAX_HISTORY_CHARACTERS,
  MAX_HISTORY_MESSAGES,
  type HistoryMessage,
} from "@/lib/chat/context";

function makeHistory(n: number, charsEach = 10): HistoryMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: "x".repeat(charsEach) + `-${i}`,
  }));
}

describe("buildGeminiHistory", () => {
  it("maps user/assistant roles to Gemini's user/model roles", () => {
    const result = buildGeminiHistory([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(result.map((m) => m.role)).toEqual(["user", "model"]);
  });

  it("excludes incomplete assistant messages from context", () => {
    const result = buildGeminiHistory([
      { role: "user", content: "hi" },
      { role: "assistant", content: "cut off", status: "incomplete" },
      { role: "user", content: "still there?" },
    ]);
    expect(result).toHaveLength(2);
    expect(result.some((m) => m.parts[0].text === "cut off")).toBe(false);
  });

  it("excludes system-role rows", () => {
    const result = buildGeminiHistory([
      { role: "system", content: "internal note" },
      { role: "user", content: "hi" },
    ]);
    expect(result).toHaveLength(1);
  });

  it("caps the number of messages at MAX_HISTORY_MESSAGES", () => {
    const result = buildGeminiHistory(makeHistory(MAX_HISTORY_MESSAGES + 10));
    expect(result.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
  });

  it("always keeps the newest message even if it alone is large", () => {
    const history: HistoryMessage[] = [
      { role: "user", content: "small" },
      { role: "assistant", content: "x".repeat(MAX_HISTORY_CHARACTERS + 500) },
    ];
    const result = buildGeminiHistory(history);
    expect(result.length).toBeGreaterThan(0);
    expect(result[result.length - 1].parts[0].text.length).toBeGreaterThan(MAX_HISTORY_CHARACTERS);
  });

  it("keeps total characters within budget when history is large, preferring recency", () => {
    const history = makeHistory(MAX_HISTORY_MESSAGES, 500); // well over the char budget
    const result = buildGeminiHistory(history);
    const totalChars = result.reduce((sum, m) => sum + m.parts[0].text.length, 0);
    // Either bounded by the char budget, or it's just the single newest message.
    expect(totalChars <= MAX_HISTORY_CHARACTERS || result.length === 1).toBe(true);
    // The most recent message must be present.
    expect(result[result.length - 1].parts[0].text.endsWith(`-${MAX_HISTORY_MESSAGES - 1}`)).toBe(
      true
    );
  });

  it("preserves chronological order", () => {
    const history = makeHistory(6);
    const result = buildGeminiHistory(history);
    const indices = result.map((m) => Number(m.parts[0].text.split("-")[1]));
    const sorted = [...indices].sort((a, b) => a - b);
    expect(indices).toEqual(sorted);
  });
});
