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

import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Crc64Nvme } from "@aws-sdk/crc64-nvme";

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
  ".mp4": "video/mp4",
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

const GENERIC_BINARY_TYPES = new Set([
  "application/octet-stream",
  "binary/octet-stream",
]);

// Watcher PUTs of uppercase extensions (`.PDF`) often land in S3 as
// `binary/octet-stream` even when `files.content_type` is correct. Prefer
// the stored type unless it is a generic binary type, then fall back to
// the extension so an iframe can render the file.
export function contentTypeForDownload(
  stored: string | null | undefined,
  filename: string
): string | undefined {
  if (stored && !GENERIC_BINARY_TYPES.has(stored.toLowerCase())) {
    return stored;
  }
  const inferred = mimeFor(filename);
  return inferred === "application/octet-stream" ? undefined : inferred;
}

export type ByteRange =
  | { kind: "full" }
  | { kind: "partial"; start: number; end: number }
  | { kind: "unsatisfiable" };

// Safari (and Chrome when scrubbing) send `Range` against the local
// mirror the same way they do against S3. A 200 of the whole file
// without `Accept-Ranges` leaves seeking broken in local dev.
export function parseByteRange(
  header: string | null,
  fileSize: number
): ByteRange {
  if (!header) {
    return { kind: "full" };
  }
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match) {
    return { kind: "full" };
  }
  const startToken = match[1];
  const endToken = match[2];
  if (startToken === "" && endToken === "") {
    return { kind: "full" };
  }
  if (fileSize === 0) {
    return { kind: "unsatisfiable" };
  }
  if (startToken === "") {
    const suffix = Number(endToken);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return { kind: "unsatisfiable" };
    }
    return {
      kind: "partial",
      start: Math.max(0, fileSize - suffix),
      end: fileSize - 1,
    };
  }
  const start = Number(startToken);
  const end =
    endToken === "" ? fileSize - 1 : Math.min(Number(endToken), fileSize - 1);
  if (
    !(Number.isFinite(start) && Number.isFinite(end)) ||
    start >= fileSize ||
    start > end
  ) {
    return { kind: "unsatisfiable" };
  }
  return { kind: "partial", start, end };
}

// Sanitize a filename for use inside a `Content-Disposition` header.
// Shared with the AWS presign path so local and S3 responses match.
function sanitizeContentDispositionFilename(name: string): string {
  const cleaned = name
    .replaceAll(/[\r\n"\\]/g, "")
    .replaceAll(/[\x00-\x1f\x7f]/g, "")
    .trim();
  return cleaned.slice(0, 200) || "download";
}

// `filename` without `disposition` stays `attachment` so archive downloads
// keep their previous signed header. Report embeds pass `inline`.
export function contentDispositionHeader(
  disposition?: "attachment" | "inline",
  filename?: string
): string | undefined {
  if (!(disposition || filename)) {
    return;
  }
  const kind = disposition ?? "attachment";
  if (!filename) {
    return kind;
  }
  return `${kind}; filename="${sanitizeContentDispositionFilename(filename)}"`;
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
// themselves — see developer-docs/local-development.md.
export function localMirrorDownloadUrl(
  bucket: string,
  key: string,
  options: {
    disposition?: "attachment" | "inline";
    filename?: string;
  } = {}
): string {
  const segments = key.split("/").map(encodeURIComponent).join("/");
  const header = contentDispositionHeader(
    options.disposition,
    options.filename
  );
  const search = header ? `?disposition=${encodeURIComponent(header)}` : "";
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

export class MirrorMultipartError extends Error {
  readonly code: string;
  readonly httpStatus: number;

  constructor(code: string, message: string, httpStatus = 400) {
    super(message);
    this.name = code;
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// `next start` in the integration harness sets NODE_ENV=production, which
// turns `getLocalMirrorRoot` off. The harness sets this instead so multipart
// tests can run without AWS. Vercel always sets `VERCEL`, so a deployment
// cannot take this path.
export function mirrorRootForMultipart(): string | null {
  const local = getLocalMirrorRoot();
  if (local) {
    return local;
  }
  if (process.env.VERCEL) {
    return null;
  }
  const testRoot = process.env.INTEGRATION_TEST_S3_MIRROR;
  return testRoot ? path.resolve(testRoot) : null;
}

interface MultipartMeta {
  bucket: string;
  contentType: string | null;
  key: string;
}

function assertUploadId(uploadId: string): void {
  if (!/^[a-f0-9]{32}$/.test(uploadId)) {
    throw new MirrorMultipartError("NoSuchUpload", "Unknown multipart upload");
  }
}

function multipartDir(root: string, uploadId: string): string {
  assertUploadId(uploadId);
  const dir = path.resolve(root, ".multipart", uploadId);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (!dir.startsWith(rootWithSep)) {
    throw new MirrorMultipartError("NoSuchUpload", "Unknown multipart upload");
  }
  return dir;
}

async function readMeta(
  root: string,
  uploadId: string
): Promise<MultipartMeta> {
  try {
    const raw = await readFile(
      path.join(multipartDir(root, uploadId), "meta.json"),
      "utf8"
    );
    return JSON.parse(raw) as MultipartMeta;
  } catch (err) {
    if (err instanceof MirrorMultipartError) {
      throw err;
    }
    throw new MirrorMultipartError("NoSuchUpload", "Unknown multipart upload");
  }
}

export async function localCreateMultipartUpload(
  root: string,
  bucket: string,
  key: string,
  contentType?: string
): Promise<string> {
  const uploadId = randomBytes(16).toString("hex");
  const dir = multipartDir(root, uploadId);
  await mkdir(path.join(dir, "parts"), { recursive: true });
  const meta: MultipartMeta = {
    bucket,
    key,
    contentType: contentType ?? null,
  };
  await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta), "utf8");
  return uploadId;
}

export function localPartUploadUrl(
  bucket: string,
  key: string,
  uploadId: string,
  partNumber: number
): string {
  const base = localMirrorUploadUrl(bucket, key);
  const params = new URLSearchParams({
    uploadId,
    partNumber: String(partNumber),
  });
  return `${base}?${params.toString()}`;
}

export async function localSavePart(
  root: string,
  uploadId: string,
  partNumber: number,
  body: Readable
): Promise<string> {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
    throw new MirrorMultipartError(
      "InvalidPart",
      "Part number must be from 1 to 10000"
    );
  }
  await readMeta(root, uploadId);
  const partPath = path.join(
    multipartDir(root, uploadId),
    "parts",
    String(partNumber)
  );
  const hash = createHash("md5");
  const hasher = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(body, hasher, createWriteStream(partPath));
  return `"${hash.digest("hex")}"`;
}

function normalizeEtag(etag: string): string {
  return etag.trim().replaceAll('"', "").toLowerCase();
}

async function crc64nvmeBase64(filePath: string): Promise<string> {
  const checksum = new Crc64Nvme();
  for await (const chunk of createReadStream(filePath)) {
    checksum.update(chunk as Uint8Array);
  }
  const digest = await checksum.digest();
  return Buffer.from(digest).toString("base64");
}

export async function localCompleteMultipartUpload(
  root: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[],
  checksumCrc64nvme: string,
  sizeBytes: number
): Promise<void> {
  const meta = await readMeta(root, uploadId);
  const dir = multipartDir(root, uploadId);
  const dest = resolveMirrorPath(root, meta.bucket, meta.key);
  await mkdir(path.dirname(dest), { recursive: true });
  const out = createWriteStream(dest);
  try {
    for (const part of parts) {
      const partPath = path.join(dir, "parts", String(part.partNumber));
      let bytes: Buffer;
      try {
        bytes = await readFile(partPath);
      } catch {
        throw new MirrorMultipartError(
          "InvalidPart",
          `Part ${part.partNumber} was not uploaded`
        );
      }
      const hash = createHash("md5").update(bytes).digest("hex");
      if (normalizeEtag(part.etag) !== hash) {
        throw new MirrorMultipartError(
          "InvalidPart",
          `ETag for part ${part.partNumber} does not match`
        );
      }
      if (bytes.length < 1 && parts.length > 1) {
        throw new MirrorMultipartError(
          "EntityTooSmall",
          `Part ${part.partNumber} is empty`
        );
      }
      await new Promise<void>((resolve, reject) => {
        out.write(bytes, (err) => (err ? reject(err) : resolve()));
      });
    }
    await new Promise<void>((resolve, reject) => {
      out.once("error", reject);
      out.end(() => resolve());
    });
  } catch (err) {
    out.destroy();
    await rm(dest, { force: true });
    throw err;
  }

  const stored = await stat(dest);
  const checksum = await crc64nvmeBase64(dest);
  if (stored.size !== sizeBytes || checksum !== checksumCrc64nvme) {
    await rm(dest, { force: true });
    throw new MirrorMultipartError(
      "BadDigest",
      "The uploaded bytes do not match the checksum or the file size"
    );
  }
  await rm(dir, { recursive: true, force: true });
}

export async function localAbortMultipartUpload(
  root: string,
  uploadId: string
): Promise<void> {
  let dir: string;
  try {
    dir = multipartDir(root, uploadId);
  } catch (err) {
    if (err instanceof MirrorMultipartError) {
      return;
    }
    throw err;
  }
  await rm(dir, { recursive: true, force: true });
}

export async function localObjectChecksum(
  root: string,
  bucket: string,
  key: string
): Promise<{ sizeBytes: number; checksumCrc64nvme: string } | null> {
  const head = await localMirrorHead(root, bucket, key);
  if (!head.exists) {
    return null;
  }
  const filePath = resolveMirrorPath(root, bucket, key);
  return {
    sizeBytes: head.sizeBytes,
    checksumCrc64nvme: await crc64nvmeBase64(filePath),
  };
}
