/**
 * Normalizes raw extracted text before it's stored or sent to Gemini.
 * Deliberately conservative: collapses noise without destroying
 * meaningful structure (paragraph breaks, lists) that makes a document
 * useful to ask questions about.
 */
export function normalizeExtractedText(raw: string): string {
  return (
    raw
      // Normalize line endings.
      .replace(/\r\n?/g, "\n")
      // Common PDF page-break artifact from form-feed-adjacent extraction.
      // Handled before the control-character strip below, since form
      // feed (\u000C) would otherwise just be silently deleted there.
      .replace(/\f/g, "\n\n")
      // Strip non-printable control characters (keep tab/newline).
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/g, "")
      // Collapse runs of 3+ blank lines down to a single paragraph break.
      .replace(/\n{3,}/g, "\n\n")
      // Collapse repeated horizontal whitespace, but preserve newlines.
      .replace(/[ \t]{2,}/g, " ")
      // Trim trailing whitespace on each line.
      .split("\n")
      .map((line) => line.trimEnd())
      .join("\n")
      .trim()
  );
}

/** Below this many non-whitespace characters, a document is treated as effectively empty. */
export const MIN_MEANINGFUL_CHARACTERS = 20;

export function hasMeaningfulText(text: string): boolean {
  return text.replace(/\s/g, "").length >= MIN_MEANINGFUL_CHARACTERS;
}
