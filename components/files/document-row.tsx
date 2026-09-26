import { FileText, MessageSquarePlus, Trash2, AlertTriangle, RotateCw, Loader2, CheckCircle2 } from "lucide-react";
import { formatFileSize } from "@/lib/documents/format";
import { cn } from "@/lib/utils";

export interface DocumentItem {
  id: string;
  filename: string;
  sizeBytes: number;
  createdAt: string;
  status: "uploading" | "processing" | "ready" | "failed";
  errorMessage?: string;
}

export function DocumentRow({
  document,
  onUse,
  onDelete,
  onRetry,
}: {
  document: DocumentItem;
  onUse: (id: string, filename: string) => void;
  onDelete: (id: string) => void;
  /** Retries a client-side re-upload (still-selected file) or, for a
   * previously-uploaded document that failed embedding, triggers
   * server-side reprocessing — see FilesView.handleRetry. */
  onRetry?: (id: string) => void;
}) {
  const extension = document.filename.split(".").pop()?.toUpperCase() ?? "FILE";

  return (
    <li className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-paper/60">
      <span
        className={cn(
          "flex h-10 w-10 shrink-0 items-center justify-center rounded-md",
          document.status === "failed" ? "bg-danger-50 text-danger-500" : "bg-paper text-ink-faint"
        )}
      >
        <FileText size={17} strokeWidth={1.75} aria-hidden="true" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-ink" title={document.filename}>
          {document.filename}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-faint">
          <span>
            {extension} · {formatFileSize(document.sizeBytes)}
            {document.status === "ready" &&
              ` · ${new Date(document.createdAt).toLocaleDateString()}`}
          </span>
          {document.status === "uploading" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-paper px-1.5 py-0.5 text-[11px] text-ink-muted">
              <Loader2 size={10} strokeWidth={2.5} className="animate-spin" aria-hidden="true" />
              Uploading
            </span>
          )}
          {document.status === "processing" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-clay-50 px-1.5 py-0.5 text-[11px] text-clay-500">
              <Loader2 size={10} strokeWidth={2.5} className="animate-spin" aria-hidden="true" />
              Processing
            </span>
          )}
          {document.status === "ready" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-moss-50 px-1.5 py-0.5 text-[11px] text-moss-600">
              <CheckCircle2 size={10} strokeWidth={2.5} aria-hidden="true" />
              Ready
            </span>
          )}
        </p>
        {document.status === "failed" && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-danger-500">
            <AlertTriangle size={11} strokeWidth={2} aria-hidden="true" />
            {document.errorMessage ?? "Upload failed."}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {document.status === "ready" && (
          <button
            type="button"
            onClick={() => onUse(document.id, document.filename)}
            title="Ask about this document in a new chat"
            aria-label={`Use ${document.filename} in a new chat`}
            className="flex h-8 w-8 items-center justify-center rounded text-ink-muted transition-colors hover:bg-paper hover:text-ink"
          >
            <MessageSquarePlus size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
        {document.status === "failed" && onRetry && (
          <button
            type="button"
            onClick={() => onRetry(document.id)}
            title="Retry processing"
            aria-label={`Retry processing ${document.filename}`}
            className="flex h-8 w-8 items-center justify-center rounded text-ink-muted transition-colors hover:bg-paper hover:text-ink"
          >
            <RotateCw size={15} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
        {document.status !== "uploading" && (
          <button
            type="button"
            onClick={() => onDelete(document.id)}
            title="Delete"
            aria-label={`Delete ${document.filename}`}
            className="flex h-8 w-8 items-center justify-center rounded text-ink-muted transition-colors hover:bg-danger-50 hover:text-danger-500"
          >
            <Trash2 size={15} strokeWidth={1.75} aria-hidden="true" />
          </button>
        )}
      </div>
    </li>
  );
}
