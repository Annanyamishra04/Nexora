import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/layout/page-header";
import { FilesView } from "@/components/files/files-view";
import type { DocumentItem } from "@/components/files/document-row";

export const metadata: Metadata = { title: "Files — Nexora" };

export default async function FilesPage() {
  const supabase = await createClient();
  const { data } = await supabase
    .from("documents")
    .select("id, filename, size_bytes, created_at, extraction_status, processing_error")
    .order("created_at", { ascending: false });

  const initialDocuments: DocumentItem[] = (data ?? []).map((row) => ({
    id: row.id,
    filename: row.filename,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    // documents.extraction_status is "processing" | "ready" | "failed"
    // (see supabase/migrations/0005_rag.sql) — maps directly onto
    // DocumentItem's status, distinct from the purely client-side
    // "uploading" state used while a file is mid-upload.
    status: row.extraction_status,
    errorMessage: row.processing_error ?? undefined,
  }));

  return (
    <div>
      <PageHeader
        title="Files"
        description="Upload documents to ask questions grounded in your own sources."
      />
      <FilesView initialDocuments={initialDocuments} />
    </div>
  );
}
