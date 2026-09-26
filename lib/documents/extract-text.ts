import { getDocumentProxy, extractText as extractPdfText } from "unpdf";
import mammoth from "mammoth";
import { documentError, mapDocumentError } from "@/lib/documents/errors";
import { normalizeExtractedText, hasMeaningfulText } from "@/lib/documents/normalize";
import type { SupportedExtension } from "@/lib/documents/validate";

export interface ExtractedDocument {
  text: string;
  type: SupportedExtension;
  meta: { pageCount?: number };
}

/**
 * Extracts and normalizes text from a supported document buffer. Never
 * tightly coupled to the API route — callers just get text back or a
 * safe DocumentExtractionError. Throws on:
 *  - a malformed/password-protected/corrupted file the parser can't read
 *  - a file that decodes but contains no meaningful text (e.g. a scanned
 *    PDF with no text layer — OCR is not implemented, see docs)
 */
export async function extractDocumentText(
  buffer: Buffer,
  extension: SupportedExtension
): Promise<ExtractedDocument> {
  let raw: string;
  let pageCount: number | undefined;

  try {
    switch (extension) {
      case "pdf": {
        const pdf = await getDocumentProxy(new Uint8Array(buffer));
        const result = await extractPdfText(pdf, { mergePages: true });
        raw = result.text;
        pageCount = result.totalPages;
        break;
      }
      case "docx": {
        const result = await mammoth.extractRawText({ buffer });
        raw = result.value;
        break;
      }
      case "txt":
      case "md": {
        raw = buffer.toString("utf-8");
        break;
      }
      default: {
        // Exhaustiveness guard — validate.ts should never let another
        // value reach here.
        const _never: never = extension;
        throw documentError("unsupported_type", "Unsupported file type.");
      }
    }
  } catch (error) {
    throw mapDocumentError(error);
  }

  const text = normalizeExtractedText(raw);

  if (!hasMeaningfulText(text)) {
    throw documentError(
      "empty_content",
      extension === "pdf"
        ? "No readable text was found in this PDF. If it's a scanned document, note that Nexora doesn't support OCR yet."
        : "No readable text was found in this file."
    );
  }

  return { text, type: extension, meta: { pageCount } };
}
