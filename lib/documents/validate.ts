import { documentError } from "@/lib/documents/errors";
import {
  MAX_FILE_SIZE_BYTES,
  SUPPORTED_EXTENSIONS,
  getExtension,
  isSupportedExtension,
  type SupportedExtension,
} from "@/lib/documents/limits";

export { MAX_FILE_SIZE_BYTES, SUPPORTED_EXTENSIONS, getExtension, type SupportedExtension };

const ALLOWED_MIME_TYPES: Record<SupportedExtension, string[]> = {
  pdf: ["application/pdf"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  // Browsers/OSes are inconsistent about .txt/.md MIME types (often
  // empty or "application/octet-stream" for .md), so these two are
  // primarily trusted via extension + the binary-content check below
  // rather than a strict MIME allowlist.
  txt: ["text/plain", "text/markdown", "application/octet-stream", ""],
  md: ["text/markdown", "text/plain", "application/octet-stream", ""],
};

/**
 * Synchronous checks that don't require reading file contents:
 * filename/extension, claimed MIME type, and size. Always run before the
 * (async) content-based check below. Server-only (throws
 * DocumentExtractionError), but built on the same extension/size
 * constants the client uses for its own instant feedback
 * (lib/documents/limits.ts) — never trust the client-side check alone.
 */
export function validateUploadBasics(input: { filename: string; mimeType: string; size: number }) {
  const { filename, mimeType, size } = input;

  if (size <= 0) {
    throw documentError("empty_content", "This file is empty.");
  }
  if (size > MAX_FILE_SIZE_BYTES) {
    throw documentError(
      "too_large",
      `Files must be 5 MB or smaller (this one is ${(size / (1024 * 1024)).toFixed(1)} MB).`
    );
  }

  const extension = getExtension(filename);
  if (!isSupportedExtension(extension)) {
    throw documentError(
      "unsupported_type",
      "Unsupported file type. Nexora accepts PDF, DOCX, TXT, and Markdown (.md) files."
    );
  }

  const allowedMimes = ALLOWED_MIME_TYPES[extension];
  if (mimeType && !allowedMimes.includes(mimeType)) {
    throw documentError(
      "unsupported_type",
      "The file's contents don't match its extension. Please upload a genuine PDF, DOCX, TXT, or Markdown file."
    );
  }

  return { extension };
}

const PDF_MAGIC = Buffer.from("%PDF-");
// DOCX (and other OOXML formats) are ZIP archives; ZIP files start with "PK".
const ZIP_MAGIC = Buffer.from([0x50, 0x4b]);

/**
 * Content-based check, run after `validateUploadBasics`. Confirms the
 * bytes actually look like the claimed type (magic bytes for pdf/docx),
 * and for txt/md — which have no reliable magic number — rejects content
 * that looks like binary data renamed with a text extension. Uses
 * Node's Buffer, so this stays server-only (never imported by client
 * components — see lib/documents/limits.ts for the client-safe subset).
 */
export function verifyFileSignature(buffer: Buffer, extension: SupportedExtension): void {
  if (extension === "pdf") {
    if (!buffer.subarray(0, 5).equals(PDF_MAGIC)) {
      throw documentError("unsupported_type", "This doesn't look like a valid PDF file.");
    }
    return;
  }

  if (extension === "docx") {
    if (!buffer.subarray(0, 2).equals(ZIP_MAGIC)) {
      throw documentError("unsupported_type", "This doesn't look like a valid DOCX file.");
    }
    return;
  }

  // txt / md: reject if the content looks binary rather than text — a
  // renamed image or executable will contain many NUL bytes or other
  // control characters that legitimate UTF-8 text won't.
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  let suspiciousBytes = 0;
  for (const byte of sample) {
    const isPrintableOrWhitespace =
      byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte !== 127);
    // UTF-8 continuation/lead bytes for non-ASCII text are >= 0x80 and
    // are legitimate; only flag control characters and NUL.
    if (!isPrintableOrWhitespace && byte < 0x80) suspiciousBytes++;
  }
  if (sample.length > 0 && suspiciousBytes / sample.length > 0.05) {
    throw documentError(
      "unsupported_type",
      "This file doesn't look like plain text. Please upload a genuine TXT or Markdown file."
    );
  }
}
