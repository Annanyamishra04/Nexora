import { describe, expect, it } from "vitest";
import { deriveTitle } from "@/lib/chat/title";

describe("deriveTitle", () => {
  it("returns short messages unchanged", () => {
    expect(deriveTitle("What's the capital of France?")).toBe("What's the capital of France?");
  });

  it("falls back for empty/whitespace-only content", () => {
    expect(deriveTitle("   ")).toBe("New conversation");
  });

  it("collapses internal whitespace and newlines", () => {
    expect(deriveTitle("Hello\n\n  world")).toBe("Hello world");
  });

  it("truncates long messages at a word boundary with an ellipsis", () => {
    const long =
      "Can you help me understand how database indexes work and when I should add one to a large table";
    const title = deriveTitle(long);
    expect(title.length).toBeLessThanOrEqual(61); // 60 chars + ellipsis
    expect(title.endsWith("…")).toBe(true);
    expect(title.endsWith(" …")).toBe(false); // no trailing space before the ellipsis
  });

  it("never cuts mid-word for long input", () => {
    const long = "supercalifragilisticexpialidocious ".repeat(10).trim();
    const title = deriveTitle(long);
    expect(title.replace("…", "")).not.toMatch(/expialido$/);
  });
});
