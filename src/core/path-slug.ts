export interface SanitizePathSegmentOptions {
  fallback?: string;
  maxLength?: number;
}

export function sanitizePathSegment(
  value: string,
  options: SanitizePathSegmentOptions = {},
): string {
  const fallback = options.fallback ?? "test";
  const maxLength = options.maxLength ?? 80;

  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, maxLength) || fallback
  );
}
