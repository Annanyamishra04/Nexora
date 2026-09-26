import { describe, expect, it } from "vitest";
import { MAX_FILE_SIZE_BYTES, validateUploadBasics, verifyFileSignature } from "@/lib/documents/validate";
import { DocumentExtractionError } from "@/lib/documents/errors";

describe("validateUploadBasics", () => {
  it("accepts a supported extension within the size limit", () => {
    const result = validateUploadBasics({ filename: "notes.txt", mimeType: "text/plain", size: 1000 });
    expect(result.extension).toBe("txt");
  });

  it("rejects an unsupported extension", () => {
    expect(() =>
      validateUploadBasics({ filename: "image.png", mimeType: "image/png", size: 1000 })
    ).toThrow(DocumentExtractionError);
  });

  it("rejects a file with no extension", () => {
    expect(() => validateUploadBasics({ filename: "README", mimeType: "", size: 1000 })).toThrow();
  });

  it("rejects a file over the 5MB limit", () => {
    expect(() =>
      validateUploadBasics({ filename: "big.pdf", mimeType: "application/pdf", size: MAX_FILE_SIZE_BYTES + 1 })
    ).toThrow(/5 MB/);
  });

  it("accepts a file exactly at the limit", () => {
    expect(() =>
      validateUploadBasics({ filename: "big.pdf", mimeType: "application/pdf", size: MAX_FILE_SIZE_BYTES })
    ).not.toThrow();
  });

  it("rejects an empty file", () => {
    expect(() => validateUploadBasics({ filename: "empty.txt", mimeType: "text/plain", size: 0 })).toThrow(
      /empty/i
    );
  });

  it("rejects a MIME type that contradicts the extension", () => {
    expect(() =>
      validateUploadBasics({ filename: "report.pdf", mimeType: "image/png", size: 1000 })
    ).toThrow();
  });

  it("is lenient about missing/inconsistent MIME types for txt/md", () => {
    expect(() =>
      validateUploadBasics({ filename: "notes.md", mimeType: "application/octet-stream", size: 1000 })
    ).not.toThrow();
  });
});

describe("verifyFileSignature", () => {
  it("accepts a buffer with a real PDF header", () => {
    const buffer = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("rest of file")]);
    expect(() => verifyFileSignature(buffer, "pdf")).not.toThrow();
  });

  it("rejects a .pdf file whose bytes aren't actually a PDF", () => {
    const buffer = Buffer.from("This is just plain text, not a PDF.");
    expect(() => verifyFileSignature(buffer, "pdf")).toThrow();
  });

  it("accepts a buffer with a ZIP header for docx", () => {
    const buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    expect(() => verifyFileSignature(buffer, "docx")).not.toThrow();
  });

  it("rejects a .docx file that isn't a real ZIP/OOXML archive", () => {
    const buffer = Buffer.from("not a zip file at all");
    expect(() => verifyFileSignature(buffer, "docx")).toThrow();
  });

  it("accepts genuine UTF-8 text for txt", () => {
    const buffer = Buffer.from("Hello, world! This is a perfectly normal text file.\nWith a second line.");
    expect(() => verifyFileSignature(buffer, "txt")).not.toThrow();
  });

  it("accepts UTF-8 text with non-ASCII characters for md", () => {
    const buffer = Buffer.from("# Café Notes\n\nThis has emoji 🎉 and accents: café, naïve.");
    expect(() => verifyFileSignature(buffer, "md")).not.toThrow();
  });

  it("rejects binary content renamed with a .txt extension", () => {
    // Random bytes with plenty of NUL / control characters, as a
    // renamed image or executable would have.
    const buffer = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x02]);
    expect(() => verifyFileSignature(buffer, "txt")).toThrow();
  });
});
