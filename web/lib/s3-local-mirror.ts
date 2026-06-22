// Local-disk S3 mirror dispatch for the dev workflow. When
// `LOCAL_S3_MIRROR` is set (and `NODE_ENV !== "production"`),
// `web/lib/s3.ts` short-circuits its AWS SDK calls and serves bytes
// from this mirror instead. The mirror layout matches an S3 bucket
// layout: `<root>/<bucket>/<key>`.
//
// Kept in its own module so the AWS code path in `s3.ts` stays
// untouched and so callers never need to know which implementation
// they're hitting. The companion route at
// `app/api/local-s3/[bucket]/[...key]/route.ts` is the HTTP face of
// the same mirror; the lambda CLI's `data-hub-process handler`
// command is the python-side writer.
//
// Production-safety: `getLocalMirrorRoot()` returns `null` whenever
// `NODE_ENV === "production"`, so the local code path can never be
// activated in a Vercel production build even if the env var is
// somehow leaked into that environment.

import { stat } from "node:fs/promises";
import path from "node:path";

const MIME_MAP: Record<string, string> = {
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".json": "application/json",
  ".txt": "text/plain",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".nd2": "application/octet-stream",
};

export function getLocalMirrorRoot(): string | null {
  if (process.env.NODE_ENV === "production") {
    return null;
  }
  const v = process.env.LOCAL_S3_MIRROR;
  return v ? path.resolve(v) : null;
}

// Resolve `<root>/<bucket>/<key>` and refuse anything that escapes
// the mirror root. Done with a string-prefix check on the absolute
// resolved path because `path.resolve` collapses `..` segments
// before we can sanity-check them — checking the input string for
// `..` would miss URL-encoded variants and Windows-style separators.
export function resolveMirrorPath(
  root: string,
  bucket: string,
  key: string
): string {
  const resolved = path.resolve(root, bucket, key);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(rootWithSep)) {
    throw new Error(`Path traversal blocked: bucket=${bucket} key=${key}`);
  }
  return resolved;
}

export function mimeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? "application/octet-stream";
}

// Sanitize a filename for use inside a `Content-Disposition` header.
// Mirrors the same logic in `web/lib/s3.ts` so the local route's
// response headers match what the AWS path would have produced via
// `ResponseContentDisposition` on a presigned URL.
function sanitizeContentDispositionFilename(name: string): string {
  const cleaned = name
    .replaceAll(/[\r\n"\\]/g, "")
    .replaceAll(/[\x00-\x1f\x7f]/g, "")
    .trim();
  return cleaned.slice(0, 200) || "download";
}

// Build the same-origin URL that points at the local-mirror route.
// Each path segment is `encodeURIComponent`'d so a key with spaces or
// `+` round-trips correctly through the `[...key]` catch-all in the
// route handler. The bucket is encoded as a single segment.
//
// Note: the route lives at `/api/local-s3/...` (not `_local-s3`) —
// the App Router treats folders prefixed with `_` as private and
// excludes them from routing entirely, so a leading underscore
// makes every request 404 before the handler runs.
//
// Returning a same-origin (relative) URL is intentional: every
// browser-driven consumer (302 redirects, `<img src>`, `<a href>`,
// `<iframe src>`) resolves it against the current origin, and
// embedding `http://localhost:3000` would break any non-3000 dev
// setup. Non-browser MCP consumers may need to prefix the host
// themselves — see docs/local-development.md.
export function localMirrorDownloadUrl(
  bucket: string,
  key: string,
  filename?: string
): string {
  const segments = key.split("/").map(encodeURIComponent).join("/");
  const search = filename
    ? `?disposition=${encodeURIComponent(
        `attachment; filename="${sanitizeContentDispositionFilename(filename)}"`
      )}`
    : "";
  return `/api/local-s3/${encodeURIComponent(bucket)}/${segments}${search}`;
}

export function localMirrorUploadUrl(bucket: string, key: string): string {
  // Same shape as download — the route dispatches off HTTP method,
  // so a single URL serves both presigned-GET and presigned-PUT
  // semantics.
  return localMirrorDownloadUrl(bucket, key);
}

export type LocalMirrorHeadResult =
  | { exists: true; sizeBytes: number }
  | { exists: false };

// `fs.stat` wrapper that maps `ENOENT` (and any other error) to a
// clean `{ exists: false }` so the `headS3Object` shim in `s3.ts`
// can return its existing union type without changes.
export async function localMirrorHead(
  root: string,
  bucket: string,
  key: string
): Promise<LocalMirrorHeadResult> {
  try {
    const filePath = resolveMirrorPath(root, bucket, key);
    const s = await stat(filePath);
    return { exists: true, sizeBytes: s.size };
  } catch {
    return { exists: false };
  }
}
