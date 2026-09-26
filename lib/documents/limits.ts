export const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB — see docs/ARCHITECTURE.md
export const SUPPORTED_EXTENSIONS = ["pdf", "docx", "txt", "md"] as const;
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

export function getExtension(filename: string): string | null {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return match?.[1] ? match[1].toLowerCase() : null;
}

export function isSupportedExtension(ext: string | null): ext is SupportedExtension {
  return !!ext && (SUPPORTED_EXTENSIONS as readonly string[]).includes(ext);
}
