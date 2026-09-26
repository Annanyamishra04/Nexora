"use client";

import { useRef, useState, type DragEvent } from "react";
import { UploadCloud } from "lucide-react";
import { cn } from "@/lib/utils";
import { MAX_FILE_SIZE_BYTES, SUPPORTED_EXTENSIONS, getExtension, isSupportedExtension } from "@/lib/documents/limits";

const ACCEPT = SUPPORTED_EXTENSIONS.map((ext) => `.${ext}`).join(",");
const MAX_MB = MAX_FILE_SIZE_BYTES / (1024 * 1024);

export interface RejectedFile {
  file: File;
  reason: string;
}

/**
 * Client-side check purely for instant feedback — the server
 * (lib/documents/validate.ts) re-validates everything from scratch and
 * is the actual security boundary.
 */
function precheck(file: File): string | null {
  const extension = getExtension(file.name);
  if (!isSupportedExtension(extension)) {
    return "Unsupported file type. Use PDF, DOCX, TXT, or Markdown.";
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return `File is larger than ${MAX_MB}MB.`;
  }
  if (file.size === 0) {
    return "This file is empty.";
  }
  return null;
}

export function FileUploader({
  onFilesAccepted,
  onFilesRejected,
}: {
  onFilesAccepted: (files: File[]) => void;
  onFilesRejected: (rejected: RejectedFile[]) => void;
}) {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    const accepted: File[] = [];
    const rejected: RejectedFile[] = [];

    for (const file of Array.from(fileList)) {
      const reason = precheck(file);
      if (reason) rejected.push({ file, reason });
      else accepted.push(file);
    }

    if (accepted.length > 0) onFilesAccepted(accepted);
    if (rejected.length > 0) onFilesRejected(rejected);
  }

  return (
    <div
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        setIsDragging(false);
        handleFiles(e.dataTransfer.files);
      }}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center transition-colors",
        isDragging ? "border-moss-500 bg-moss-50" : "border-line bg-paper-raised/40 hover:border-line-strong"
      )}
    >
      <span className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-moss-50 text-moss-600">
        <UploadCloud size={20} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <p className="text-sm text-ink">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="font-medium text-moss-600 underline underline-offset-2 hover:text-moss-700"
        >
          Choose a file
        </button>{" "}
        or drag it here
      </p>
      <p className="text-xs text-ink-faint">PDF, DOCX, TXT, or Markdown — up to {MAX_MB}MB</p>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="sr-only"
        aria-label="Choose a file to upload"
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </div>
  );
}
