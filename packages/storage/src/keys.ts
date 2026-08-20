import { AppError } from "@ventora/observability";

const UNSAFE_FILENAME_RE = /[^a-zA-Z0-9._\-]/g;
const PATH_TRAVERSAL_RE = /\.\./;
const VALID_TENANT_RE = /^[a-zA-Z0-9-]+$/;

export function sanitizeFilename(name: string): string {
  // 1. Extract basename (strip directory separators)
  const base = name.replace(/[/\\]/g, "_").replace(/^_+/, "");

  // 2. Replace anything not in [a-zA-Z0-9._-] with "_"
  const replaced = base.replace(UNSAFE_FILENAME_RE, "_");

  // 3. Collapse multiple underscores/dots
  const collapsed = replaced.replace(/_+/g, "_").replace(/\.{2,}/g, ".");

  // 4. Truncate to 200 chars
  const truncated = collapsed.slice(0, 200);

  // 5. If result is empty, return "file"
  const trimmed = truncated.replace(/^[._]+|[._]+$/g, "");
  return trimmed.length === 0 ? "file" : trimmed;
}

export function buildTenantKey(tenantId: string, ...segments: string[]): string {
  // Validate tenantId: must be non-empty, alphanumeric + hyphens only
  if (!tenantId || !VALID_TENANT_RE.test(tenantId)) {
    throw new AppError(
      400,
      `Invalid tenantId: "${tenantId}". Must be non-empty and contain only alphanumeric characters and hyphens.`,
    );
  }

  // Validate each segment: sanitize, must be non-empty after sanitization
  if (segments.length === 0) {
    throw new AppError(400, "At least one path segment is required.");
  }

  // Reject path traversal attempts in raw segments before sanitization
  for (const seg of segments) {
    if (PATH_TRAVERSAL_RE.test(seg)) {
      throw new AppError(400, `Path traversal detected in segment: "${seg}"`);
    }
  }

  const sanitizedSegments = segments.map((seg) => sanitizeFilename(seg));

  return `${tenantId}/${sanitizedSegments.join("/")}`;
}
