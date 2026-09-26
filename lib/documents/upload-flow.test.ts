import { describe, expect, it, vi } from "vitest";
import { persistUploadedDocument } from "@/lib/documents/upload-flow";
import { DocumentExtractionError } from "@/lib/documents/errors";

const USER_ID = "11111111-1111-1111-1111-111111111111";

interface FakeSupabaseOptions {
  uploadError?: { message: string } | null;
  insertError?: { message: string } | null;
}

/**
 * A minimal stand-in for the Supabase client covering only the chained
 * calls persistUploadedDocument makes. No live Supabase connection is
 * needed to exercise the orchestration logic itself.
 */
function createFakeSupabase(options: FakeSupabaseOptions = {}) {
  const upload = vi.fn().mockResolvedValue({ error: options.uploadError ?? null });
  const remove = vi.fn().mockResolvedValue({ error: null });

  let insertedPayload: Record<string, unknown> | null = null;

  const single = vi.fn().mockImplementation(async () => {
    if (options.insertError) {
      return { data: null, error: options.insertError };
    }
    return {
      data: {
        id: insertedPayload!.id,
        filename: insertedPayload!.filename,
        mime_type: insertedPayload!.mime_type,
        size_bytes: insertedPayload!.size_bytes,
        extraction_status: "processing",
        created_at: new Date().toISOString(),
        storage_path: insertedPayload!.storage_path,
      },
      error: null,
    };
  });
  const select = vi.fn().mockReturnValue({ single });
  const insert = vi.fn().mockImplementation((payload: Record<string, unknown>) => {
    insertedPayload = payload;
    return { select };
  });

  const client = {
    storage: { from: vi.fn().mockReturnValue({ upload, remove }) },
    from: vi.fn().mockReturnValue({ insert }),
  };

  return { client, upload, remove, insert, getInsertedPayload: () => insertedPayload };
}

describe("persistUploadedDocument", () => {
  it("generates a document ID up front and uses it consistently in the storage path and the row", async () => {
    const { client, upload, getInsertedPayload } = createFakeSupabase();

    const document = await persistUploadedDocument(client as never, {
      userId: USER_ID,
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1234,
      buffer: Buffer.from("fake pdf bytes"),
      extractedText: "Some extracted text.",
    });

    const uploadedPath = upload.mock.calls[0][0] as string;
    expect(uploadedPath.startsWith(`${USER_ID}/`)).toBe(true);
    expect(uploadedPath).toContain(document.id);
    expect(getInsertedPayload()?.storage_path).toBe(uploadedPath);
    expect(getInsertedPayload()?.id).toBe(document.id);
  });

  it("does not depend on an unsanitized filename for the storage path", async () => {
    const { client, upload } = createFakeSupabase();

    await persistUploadedDocument(client as never, {
      userId: USER_ID,
      filename: "../../etc/passwd; rm -rf.txt",
      mimeType: "text/plain",
      sizeBytes: 10,
      buffer: Buffer.from("hi"),
      extractedText: "hi there, this is enough text.",
    });

    const uploadedPath = upload.mock.calls[0][0] as string;
    const lastSegment = uploadedPath.split("/").pop()!;
    expect(lastSegment).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it("creates a valid text-backed document with storage_path null when the Storage upload fails", async () => {
    const { client, getInsertedPayload } = createFakeSupabase({ uploadError: { message: "network error" } });

    const document = await persistUploadedDocument(client as never, {
      userId: USER_ID,
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 10,
      buffer: Buffer.from("hi"),
      extractedText: "This document has real extracted text regardless of storage.",
    });

    expect(document.storage_path).toBeNull();
    expect(getInsertedPayload()?.storage_path).toBeNull();
    // The row itself was still created successfully.
    expect(document.id).toBeTruthy();
    expect(document.extraction_status).toBe("processing");
  });

  it("cleans up the uploaded Storage object if the database insert fails afterward", async () => {
    const { client, remove, upload } = createFakeSupabase({ insertError: { message: "db is down" } });

    await expect(
      persistUploadedDocument(client as never, {
        userId: USER_ID,
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        buffer: Buffer.from("hi"),
        extractedText: "Enough extracted text to be meaningful.",
      })
    ).rejects.toBeInstanceOf(DocumentExtractionError);

    const uploadedPath = upload.mock.calls[0][0] as string;
    expect(remove).toHaveBeenCalledWith([uploadedPath]);
  });

  it("does not attempt Storage cleanup if the upload itself never succeeded", async () => {
    const { client, remove } = createFakeSupabase({
      uploadError: { message: "network error" },
      insertError: { message: "db is down" },
    });

    await expect(
      persistUploadedDocument(client as never, {
        userId: USER_ID,
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 10,
        buffer: Buffer.from("hi"),
        extractedText: "Enough extracted text to be meaningful.",
      })
    ).rejects.toBeInstanceOf(DocumentExtractionError);

    expect(remove).not.toHaveBeenCalled();
  });
});
