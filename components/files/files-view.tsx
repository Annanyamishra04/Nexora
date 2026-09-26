"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { FolderOpen } from "lucide-react";
import { FileUploader, type RejectedFile } from "@/components/files/file-uploader";
import { DocumentRow, type DocumentItem } from "@/components/files/document-row";
import { EmptyState } from "@/components/ui/empty-state";

interface UploadingItem extends DocumentItem {
  file?: File;
}

let tempIdCounter = 0;
function tempId() {
  tempIdCounter += 1;
  return `pending-${tempIdCounter}`;
}

async function uploadFile(file: File): Promise<{ ok: true; document: DocumentItem } | { ok: false; message: string }> {
  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("/api/documents", { method: "POST", body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: data.error || "Upload failed." };
    }
    return {
      ok: true,
      document: {
        id: data.document.id,
        filename: data.document.filename,
        sizeBytes: data.document.size_bytes,
        createdAt: data.document.created_at,
        // The upload request now runs extraction *and* embedding before
        // responding (see app/api/documents/route.ts), so the returned
        // extraction_status already reflects the real outcome — "ready"
        // only once chunks are actually stored, "failed" with a safe
        // processing_error otherwise. Never optimistically "ready".
        status: data.document.extraction_status,
        errorMessage: data.document.processing_error ?? undefined,
      },
    };
  } catch {
    return { ok: false, message: "Couldn't reach the server. Check your connection and try again." };
  }
}

async function reprocessDocument(
  id: string
): Promise<{ ok: true; document: DocumentItem } | { ok: false; message: string }> {
  try {
    const res = await fetch(`/api/documents/${id}/reprocess`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, message: data.error || "Reprocessing failed." };
    }
    return {
      ok: true,
      document: {
        id: data.document.id,
        filename: data.document.filename,
        sizeBytes: data.document.size_bytes,
        createdAt: data.document.created_at,
        status: data.document.extraction_status,
        errorMessage: data.document.processing_error ?? undefined,
      },
    };
  } catch {
    return { ok: false, message: "Couldn't reach the server. Check your connection and try again." };
  }
}

export function FilesView({ initialDocuments }: { initialDocuments: DocumentItem[] }) {
  const router = useRouter();
  const [documents, setDocuments] = useState<UploadingItem[]>(initialDocuments);

  async function startUpload(file: File) {
    const id = tempId();
    setDocuments((prev) => [
      { id, filename: file.name, sizeBytes: file.size, createdAt: new Date().toISOString(), status: "uploading", file },
      ...prev,
    ]);

    const result = await uploadFile(file);

    setDocuments((prev) => {
      if (result.ok) {
        return prev.map((d) => (d.id === id ? { ...result.document } : d));
      }
      return prev.map((d) => (d.id === id ? { ...d, status: "failed", errorMessage: result.message } : d));
    });
  }

  function handleFilesAccepted(files: File[]) {
    files.forEach((file) => void startUpload(file));
  }

  function handleFilesRejected(rejected: RejectedFile[]) {
    setDocuments((prev) => [
      ...rejected.map(({ file, reason }) => ({
        id: tempId(),
        filename: file.name,
        sizeBytes: file.size,
        createdAt: new Date().toISOString(),
        status: "failed" as const,
        errorMessage: reason,
      })),
      ...prev,
    ]);
  }

  function handleRetry(id: string) {
    const item = documents.find((d) => d.id === id);
    if (!item) return;

    // A row still holding its original File object (rejected client-side,
    // or failed before a document row ever existed) is retried by
    // re-uploading from scratch. A row for a document that made it into
    // the database but failed embedding (no File object — it came back
    // from the server, or from the initial page load) is retried via the
    // reprocess endpoint instead, reusing its already-extracted text
    // rather than requiring the person to re-select the file.
    if (item.file) {
      setDocuments((prev) => prev.filter((d) => d.id !== id));
      void startUpload(item.file);
      return;
    }

    setDocuments((prev) => prev.map((d) => (d.id === id ? { ...d, status: "processing", errorMessage: undefined } : d)));

    void reprocessDocument(id).then((result) => {
      setDocuments((prev) =>
        prev.map((d) => (d.id === id ? (result.ok ? { ...result.document } : { ...d, status: "failed", errorMessage: result.message }) : d))
      );
    });
  }

  async function handleDelete(id: string) {
    const previous = documents;
    setDocuments((prev) => prev.filter((d) => d.id !== id));

    try {
      const res = await fetch(`/api/documents/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setDocuments(previous); // couldn't delete — restore the row
      }
    } catch {
      setDocuments(previous);
    }
  }

  function handleUse(id: string) {
    router.push(`/chat?doc=${id}`);
  }

  const isEmpty = documents.length === 0;

  return (
    <div className="p-6 lg:p-10">
      <div className="mb-6">
        <FileUploader onFilesAccepted={handleFilesAccepted} onFilesRejected={handleFilesRejected} />
      </div>

      {isEmpty ? (
        <EmptyState
          icon={FolderOpen}
          title="No documents yet"
          description="Upload a PDF, DOCX, TXT, or Markdown file to ask questions grounded in it from a chat."
        />
      ) : (
        <ul className="divide-y divide-line card-surface">
          {documents.map((document) => (
            <DocumentRow
              key={document.id}
              document={document}
              onUse={handleUse}
              onDelete={handleDelete}
              onRetry={handleRetry}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
