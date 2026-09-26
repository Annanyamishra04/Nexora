import { CHUNK_MAX_CHARS, CHUNK_MIN_CHARS, CHUNK_OVERLAP_CHARS } from "@/lib/rag/config";

export interface TextChunk {
  index: number;
  content: string;
}

/**
 * Deterministic, character-based chunking. There is no token counting
 * here — character count is a rough (documented) approximation of token
 * count, conservative enough to stay well under gemini-embedding-001's
 * 2,048-token/input limit at the chosen CHUNK_MAX_CHARS default. The same
 * input always produces the same chunks: no randomness, no wall-clock
 * dependence, no external calls.
 *
 * Strategy:
 *  1. Split on paragraph breaks (blank lines) — the cheapest available
 *     signal for "don't cut here" that survives lib/documents/normalize.ts.
 *  2. Greedily pack whole paragraphs into a chunk until the next paragraph
 *     would push it over CHUNK_MAX_CHARS, then flush.
 *  3. A single paragraph longer than CHUNK_MAX_CHARS on its own is split
 *     at sentence boundaries where possible, falling back to word
 *     boundaries so a chunk boundary never lands mid-word.
 *  4. Each new chunk (after the first) is seeded with up to
 *     CHUNK_OVERLAP_CHARS of trailing context from the previous chunk, so
 *     a fact split across a flush point is still findable from either
 *     side.
 *  5. A trailing chunk shorter than CHUNK_MIN_CHARS is merged into the
 *     previous chunk instead of being stored (and embedded) on its own.
 */
export function chunkText(rawText: string): TextChunk[] {
  const text = rawText.trim();
  if (!text) return [];

  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (paragraphs.length === 0) return [];

  const pieces: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= CHUNK_MAX_CHARS) {
      pieces.push(paragraph);
    } else {
      pieces.push(...splitLongParagraph(paragraph));
    }
  }

  const flushed: string[] = [];
  let buffer = "";

  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed) flushed.push(trimmed);
    buffer = "";
  };

  for (const piece of pieces) {
    const candidate = buffer ? `${buffer}\n\n${piece}` : piece;
    if (candidate.length > CHUNK_MAX_CHARS && buffer) {
      flush();
      buffer = seedOverlap(flushed[flushed.length - 1]) + piece;
    } else {
      buffer = candidate;
    }
  }
  flush();

  // Merge a too-small trailing fragment into its predecessor rather than
  // storing (and later embedding) a near-empty chunk.
  if (flushed.length > 1) {
    const last = flushed[flushed.length - 1]!;
    if (last.length < CHUNK_MIN_CHARS) {
      flushed[flushed.length - 2] = `${flushed[flushed.length - 2]}\n\n${last}`.slice(
        0,
        // Merging can exceed CHUNK_MAX_CHARS slightly; that's an accepted
        // trade-off (a single small merge, bounded by CHUNK_MIN_CHARS) in
        // exchange for never embedding a near-empty final chunk.
        CHUNK_MAX_CHARS + CHUNK_MIN_CHARS
      );
      flushed.pop();
    }
  }

  return flushed.map((content, index) => ({ index, content }));
}

/** Trailing context (word-boundary-safe) carried into the next chunk. */
function seedOverlap(previousChunk: string | undefined): string {
  if (!previousChunk || CHUNK_OVERLAP_CHARS <= 0) return "";
  const tail = previousChunk.slice(-CHUNK_OVERLAP_CHARS);
  const firstSpace = tail.indexOf(" ");
  // Drop a leading partial word so the overlap itself starts cleanly.
  const clean = firstSpace > -1 && firstSpace < tail.length - 1 ? tail.slice(firstSpace + 1) : tail;
  return clean ? `${clean}\n\n` : "";
}

const SENTENCE_BOUNDARY = /(?<=[.!?])\s+(?=[A-Z0-9"'(])/;

function splitLongParagraph(paragraph: string): string[] {
  const sentences = paragraph.split(SENTENCE_BOUNDARY).filter(Boolean);
  const result: string[] = [];
  let buffer = "";

  for (const sentence of sentences) {
    const candidate = buffer ? `${buffer} ${sentence}` : sentence;
    if (candidate.length > CHUNK_MAX_CHARS) {
      if (buffer) result.push(buffer);
      if (sentence.length > CHUNK_MAX_CHARS) {
        result.push(...splitByWords(sentence));
        buffer = "";
      } else {
        buffer = sentence;
      }
    } else {
      buffer = candidate;
    }
  }
  if (buffer) result.push(buffer);

  return result;
}

/** Last-resort splitter for a single sentence/token run longer than CHUNK_MAX_CHARS, still snapping to word boundaries. */
function splitByWords(text: string): string[] {
  const words = text.split(/\s+/);
  const result: string[] = [];
  let buffer = "";

  for (const word of words) {
    const candidate = buffer ? `${buffer} ${word}` : word;
    if (candidate.length > CHUNK_MAX_CHARS && buffer) {
      result.push(buffer);
      buffer = word;
    } else {
      buffer = candidate;
    }
  }
  if (buffer) result.push(buffer);

  return result;
}
