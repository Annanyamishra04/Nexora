import { describe, expect, it } from "vitest";
import { buildStoragePath } from "@/lib/documents/storage";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const DOCUMENT_ID = "22222222-2222-2222-2222-222222222222";

describe("buildStoragePath", () => {
  it("always starts with the user ID, then the document ID", () => {
    const path = buildStoragePath(USER_ID, DOCUMENT_ID, "report.pdf");
    expect(path.startsWith(`${USER_ID}/${DOCUMENT_ID}/`)).toBe(true);
  });

  it("strips path separators from the filename so it can't escape its folder", () => {
    const path = buildStoragePath(USER_ID, DOCUMENT_ID, "../../etc/passwd");
    const lastSegment = path.split("/").pop()!;
    expect(lastSegment).not.toMatch(/[/\\]/);
    expect(path.split("/")).toHaveLength(3); // userId / documentId / sanitized-name
  });

  it("strips characters outside a safe allowlist", () => {
    const path = buildStoragePath(USER_ID, DOCUMENT_ID, 'weird name!@#$%^&*().txt');
    const lastSegment = path.split("/").pop()!;
    expect(lastSegment).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  it("never produces an empty final segment", () => {
    const path = buildStoragePath(USER_ID, DOCUMENT_ID, "////");
    const lastSegment = path.split("/").pop()!;
    expect(lastSegment.length).toBeGreaterThan(0);
  });
});
