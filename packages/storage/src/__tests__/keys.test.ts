import { AppError } from "@ventora/observability";
import { describe, expect, it } from "vitest";
import { buildTenantKey, sanitizeFilename } from "../keys.js";

describe("sanitizeFilename", () => {
  it("preserves allowed characters", () => {
    expect(sanitizeFilename("file-name_v2.txt")).toBe("file-name_v2.txt");
  });

  it("replaces special chars with underscores", () => {
    expect(sanitizeFilename("hello world!.txt")).toBe("hello_world_.txt");
  });

  it("strips forward slash path separators", () => {
    expect(sanitizeFilename("path/to/file.txt")).toBe("path_to_file.txt");
  });

  it("strips backslash path separators", () => {
    expect(sanitizeFilename("path\\to\\file.txt")).toBe("path_to_file.txt");
  });

  it("collapses multiple underscores", () => {
    const result = sanitizeFilename("hello   world.txt");
    expect(result).toBe("hello_world.txt");
  });

  it("collapses multiple dots", () => {
    const result = sanitizeFilename("hello..world.txt");
    expect(result).not.toMatch(/\.{2,}/);
  });

  it("truncates to 200 characters", () => {
    const long = `${"a".repeat(300)}.txt`;
    const result = sanitizeFilename(long);
    expect(result.length).toBeLessThanOrEqual(200);
  });

  it("returns 'file' for empty string", () => {
    expect(sanitizeFilename("")).toBe("file");
  });

  it("returns 'file' for string with only unsafe chars", () => {
    expect(sanitizeFilename("!!!")).toBe("file");
  });

  it("returns 'file' for string that collapses to empty", () => {
    expect(sanitizeFilename("...")).toBe("file");
  });

  it("handles filename with no extension", () => {
    expect(sanitizeFilename("myfile")).toBe("myfile");
  });

  it("handles alphanumeric with hyphens and underscores", () => {
    expect(sanitizeFilename("my-file_name123")).toBe("my-file_name123");
  });

  it("handles unicode characters by replacing them", () => {
    const result = sanitizeFilename("café.txt");
    expect(result).toMatch(/^[a-zA-Z0-9._\-]+$/);
  });
});

describe("buildTenantKey", () => {
  it("constructs correct path with single segment", () => {
    expect(buildTenantKey("tenant1", "file.txt")).toBe("tenant1/file.txt");
  });

  it("constructs correct path with multiple segments", () => {
    expect(buildTenantKey("tenant1", "uploads", "2024", "file.txt")).toBe(
      "tenant1/uploads/2024/file.txt",
    );
  });

  it("throws AppError on empty tenantId", () => {
    expect(() => buildTenantKey("", "file.txt")).toThrow(AppError);
  });

  it("throws AppError on tenantId with slashes", () => {
    expect(() => buildTenantKey("tenant/1", "file.txt")).toThrow(AppError);
  });

  it("throws AppError on tenantId with underscores", () => {
    expect(() => buildTenantKey("tenant_1", "file.txt")).toThrow(AppError);
  });

  it("throws AppError on tenantId with spaces", () => {
    expect(() => buildTenantKey("tenant 1", "file.txt")).toThrow(AppError);
  });

  it("throws AppError on tenantId with special chars", () => {
    expect(() => buildTenantKey("tenant@1", "file.txt")).toThrow(AppError);
  });

  it("allows alphanumeric tenantId", () => {
    expect(() => buildTenantKey("abc123", "file.txt")).not.toThrow();
  });

  it("allows tenantId with hyphens", () => {
    expect(() => buildTenantKey("tenant-abc-123", "file.txt")).not.toThrow();
  });

  it("sanitizes segments", () => {
    const result = buildTenantKey("tenant1", "my file!.txt");
    expect(result).toBe("tenant1/my_file_.txt");
  });

  it("throws AppError when no segments provided", () => {
    expect(() => buildTenantKey("tenant1")).toThrow(AppError);
  });

  it("throws AppError with status 400 for invalid tenantId", () => {
    try {
      buildTenantKey("", "file.txt");
      expect.fail("Expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(400);
    }
  });

  it("throws AppError on segment containing '..'", () => {
    expect(() => buildTenantKey("tenant1", "../etc/passwd")).toThrow(AppError);
  });

  it("throws AppError on segment that is exactly '..'", () => {
    expect(() => buildTenantKey("tenant1", "..")).toThrow(AppError);
  });

  it("throws AppError on segment with '..' embedded", () => {
    expect(() => buildTenantKey("tenant1", "uploads", "a..b", "file.txt")).toThrow(AppError);
  });
});
