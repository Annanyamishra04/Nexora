import { describe, expect, it } from "vitest";
import { normalizeExtractedText, hasMeaningfulText, MIN_MEANINGFUL_CHARACTERS } from "@/lib/documents/normalize";

describe("normalizeExtractedText", () => {
  it("normalizes Windows line endings to \\n", () => {
    expect(normalizeExtractedText("line one\r\nline two")).toBe("line one\nline two");
  });

  it("collapses 3+ blank lines down to a single paragraph break", () => {
    expect(normalizeExtractedText("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("converts form-feed page breaks into a paragraph break", () => {
    expect(normalizeExtractedText("page one\fpage two")).toBe("page one\n\npage two");
  });

  it("strips non-printable control characters but keeps tabs and newlines", () => {
    const withControlChars = "hello\u0000\u0001 world\tindented\nnext line";
    expect(normalizeExtractedText(withControlChars)).toBe("hello world\tindented\nnext line");
  });

  it("collapses repeated horizontal whitespace without touching newlines", () => {
    expect(normalizeExtractedText("a     b\nc")).toBe("a b\nc");
  });

  it("trims trailing whitespace per line and at the ends", () => {
    expect(normalizeExtractedText("  line one   \n  line two   \n\n")).toBe("line one\n line two");
  });

  it("preserves meaningful paragraph structure rather than collapsing to one line", () => {
    const input = "Paragraph one.\n\nParagraph two.\n\nParagraph three.";
    expect(normalizeExtractedText(input)).toBe(input);
  });

  it("does not lowercase content", () => {
    expect(normalizeExtractedText("IMPORTANT Notice")).toBe("IMPORTANT Notice");
  });
});

describe("hasMeaningfulText", () => {
  it("rejects an empty string", () => {
    expect(hasMeaningfulText("")).toBe(false);
  });

  it("rejects whitespace-only content", () => {
    expect(hasMeaningfulText("   \n\n   \t  ")).toBe(false);
  });

  it("rejects content just under the threshold", () => {
    expect(hasMeaningfulText("a".repeat(MIN_MEANINGFUL_CHARACTERS - 1))).toBe(false);
  });

  it("accepts content at or over the threshold", () => {
    expect(hasMeaningfulText("a".repeat(MIN_MEANINGFUL_CHARACTERS))).toBe(true);
  });

  it("counts only non-whitespace characters toward the threshold", () => {
    const paddedWithSpaces = "hi " + " ".repeat(100);
    expect(hasMeaningfulText(paddedWithSpaces)).toBe(false);
  });
});
