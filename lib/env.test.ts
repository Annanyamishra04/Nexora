import { afterEach, describe, expect, it, vi } from "vitest";
import { readEnvInt, validateEnv, validateServerEnv } from "@/lib/env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("validateEnv", () => {
  it("is ok when both required Supabase variables are set", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");

    expect(validateEnv()).toEqual({ ok: true, missingRequired: [] });
  });

  it("reports every missing required variable by name, never a value", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");

    const result = validateEnv();
    expect(result.ok).toBe(false);
    expect(result.missingRequired).toEqual(
      expect.arrayContaining(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"])
    );
  });

  it("does not require optional variables like GEMINI_API_KEY", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    vi.stubEnv("GEMINI_API_KEY", "");

    expect(validateEnv().ok).toBe(true);
  });
});

describe("validateServerEnv", () => {
  it("throws in production when required variables are missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");

    expect(() => validateServerEnv()).toThrow(/Missing required environment variable/);
  });

  it("does not throw in development when required variables are missing (warns instead)", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(() => validateServerEnv()).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("does not throw in production when required variables are present", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");

    expect(() => validateServerEnv()).not.toThrow();
  });
});

describe("readEnvInt", () => {
  it("returns the fallback when unset", () => {
    vi.stubEnv("SOME_UNSET_VAR", "");
    expect(readEnvInt("SOME_UNSET_VAR", 42, 1, 100)).toBe(42);
  });

  it("parses and clamps a set value", () => {
    vi.stubEnv("SOME_VAR", "500");
    expect(readEnvInt("SOME_VAR", 42, 1, 100)).toBe(100);
  });

  it("falls back on a non-numeric value", () => {
    vi.stubEnv("SOME_VAR", "not-a-number");
    expect(readEnvInt("SOME_VAR", 42, 1, 100)).toBe(42);
  });
});
