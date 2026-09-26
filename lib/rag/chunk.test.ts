import { describe, expect, it } from "vitest";
import { chunkText } from "@/lib/rag/chunk";
import { CHUNK_MAX_CHARS, CHUNK_OVERLAP_CHARS } from "@/lib/rag/config";

function paragraph(word: string, words: number): string {
  return Array.from({ length: words }, (_, i) => `${word}${i}`).join(" ");
}

describe("chunkText", () => {
  it("returns no chunks for empty or whitespace-only input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("returns a single chunk for short text", () => {
    const chunks = chunkText("Hello world. This is a short document.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({ index: 0, content: "Hello world. This is a short document." });
  });

  it("is deterministic: the same input always produces the same chunks", () => {
    const text = Array.from({ length: 12 }, (_, i) => paragraph(`para${i}`, 80)).join("\n\n");
    const first = chunkText(text);
    const second = chunkText(text);
    expect(second).toEqual(first);
  });

  it("packs multiple short paragraphs into one chunk under the size cap", () => {
    const text = ["First paragraph.", "Second paragraph.", "Third paragraph."].join("\n\n");
    const chunks = chunkText(text);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toContain("First paragraph.");
    expect(chunks[0]!.content).toContain("Third paragraph.");
  });

  it("splits into multiple chunks once content exceeds the max size, each within budget", () => {
    // Comfortably exceeds CHUNK_MAX_CHARS across several large paragraphs.
    const text = Array.from({ length: 6 }, (_, i) => paragraph(`word${i}`, 400)).join("\n\n");
    const chunks = chunkText(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // A little slack is allowed for the small-trailing-chunk merge, but
      // chunks should never balloon far past the configured max.
      expect(chunk.content.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS * 2);
    }
  });

  it("never cuts a word in half, even for a single paragraph far longer than the max size", () => {
    const longParagraph = paragraph("token", 2000); // no newlines at all
    const chunks = chunkText(longParagraph);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.content.startsWith(" ")).toBe(false);
      expect(chunk.content.endsWith(" ")).toBe(false);
      // Every word in the chunk should be a complete "tokenN" token, never
      // a fragment like "toke" or "n123".
      for (const word of chunk.content.split(/\s+/)) {
        if (!word) continue;
        expect(/^token\d+$/.test(word)).toBe(true);
      }
    }
  });

  it("carries overlap from the end of one chunk into the start of the next", () => {
    if (CHUNK_OVERLAP_CHARS <= 0) return; // overlap disabled via env; nothing to assert
    const text = Array.from({ length: 6 }, (_, i) => paragraph(`w${i}`, 400)).join("\n\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);

    const firstChunkTail = chunks[0]!.content.slice(-40);
    const secondChunkWords = new Set(chunks[1]!.content.split(/\s+/));
    const tailWords = firstChunkTail.split(/\s+/).filter(Boolean);
    // At least some of the trailing words from chunk 0 should reappear at
    // the start of chunk 1 — i.e. there is real overlap, not just a clean
    // cut.
    const overlappingWords = tailWords.filter((w) => secondChunkWords.has(w));
    expect(overlappingWords.length).toBeGreaterThan(0);
  });

  it("assigns stable, zero-based, contiguous chunk indices", () => {
    const text = Array.from({ length: 6 }, (_, i) => paragraph(`idx${i}`, 400)).join("\n\n");
    const chunks = chunkText(text);
    chunks.forEach((chunk, i) => expect(chunk.index).toBe(i));
  });

  it("does not leave a tiny trailing chunk when more than one chunk is produced", () => {
    const text = Array.from({ length: 5 }, (_, i) => paragraph(`p${i}`, 400)).join("\n\n") + "\n\nTiny.";
    const chunks = chunkText(text);
    if (chunks.length > 1) {
      const last = chunks[chunks.length - 1]!;
      // Either merged away entirely, or merged into a chunk that's no
      // longer suspiciously small.
      expect(last.content.length).toBeGreaterThan(10);
    }
  });
});
