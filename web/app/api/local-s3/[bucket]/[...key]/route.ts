// Local-only S3 mirror endpoint. Serves bytes from
// `<LOCAL_S3_MIRROR>/<bucket>/<key>` on GET and writes bytes there on
// PUT. The matching dispatch lives in `web/lib/s3-local-mirror.ts`,
// which `web/lib/s3.ts` calls into when the env var is set.
//
// Gating: `getLocalMirrorRoot()` returns `null` whenever
// `NODE_ENV === "production"` OR `LOCAL_S3_MIRROR` is unset. Both
// handlers short-circuit to a 404 in that case, so a production
// build can never expose the filesystem even if the file is somehow
// included in the bundle.
//
// Runtime: stays on the default Node.js runtime — `fs` is unavailable
// on the Edge runtime and there's no production deployment story for
// this route anyway.

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import type { NextRequest } from "next/server";
import {
  getLocalMirrorRoot,
  mimeFor,
  parseByteRange,
  resolveMirrorPath,
} from "@/lib/s3-local-mirror";

interface RouteContext {
  params: Promise<{ bucket: string; key: string[] }>;
}

const NOT_FOUND_RESPONSE = () => new Response("Not Found", { status: 404 });

export async function GET(request: NextRequest, { params }: RouteContext) {
  const root = getLocalMirrorRoot();
  if (!root) {
    return NOT_FOUND_RESPONSE();
  }

  const { bucket, key } = await params;
  const joinedKey = key.join("/");

  let filePath: string;
  try {
    filePath = resolveMirrorPath(root, bucket, joinedKey);
  } catch (err) {
    console.warn(`[local-s3] rejected GET ${bucket}/${joinedKey}: ${err}`);
    return NOT_FOUND_RESPONSE();
  }

  let fileSize: number;
  try {
    const s = await stat(filePath);
    if (!s.isFile()) {
      return NOT_FOUND_RESPONSE();
    }
    fileSize = s.size;
  } catch {
    return NOT_FOUND_RESPONSE();
  }

  const disposition = new URL(request.url).searchParams.get("disposition");
  const range = parseByteRange(request.headers.get("range"), fileSize);
  const start = range.kind === "partial" ? range.start : 0;
  const end = range.kind === "partial" ? range.end : Math.max(fileSize - 1, 0);
  const length = range.kind === "unsatisfiable" ? 0 : end - start + 1;

  if (range.kind === "unsatisfiable") {
    return new Response("Range Not Satisfiable", {
      status: 416,
      headers: {
        "Content-Range": `bytes */${fileSize}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  }

  // `Readable.toWeb` returns the `node:stream/web` `ReadableStream` type,
  // which is structurally compatible with the global `ReadableStream`
  // that `Response` expects. Cast through `unknown` to bridge the two
  // declarations without pulling DOM lib types into the Node side.
  const body = Readable.toWeb(
    createReadStream(filePath, range.kind === "partial" ? { start, end } : {})
  ) as unknown as ReadableStream;

  return new Response(body, {
    status: range.kind === "partial" ? 206 : 200,
    headers: {
      "Content-Type": mimeFor(filePath),
      "Content-Length": String(range.kind === "partial" ? length : fileSize),
      "Accept-Ranges": "bytes",
      ...(range.kind === "partial" && {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      }),
      ...(disposition && { "Content-Disposition": disposition }),
      "Cache-Control": "no-store",
    },
  });
}

export async function PUT(request: NextRequest, { params }: RouteContext) {
  const root = getLocalMirrorRoot();
  if (!root) {
    return NOT_FOUND_RESPONSE();
  }

  const { bucket, key } = await params;
  const joinedKey = key.join("/");

  let filePath: string;
  try {
    filePath = resolveMirrorPath(root, bucket, joinedKey);
  } catch (err) {
    console.warn(`[local-s3] rejected PUT ${bucket}/${joinedKey}: ${err}`);
    return new Response("Bad Request", { status: 400 });
  }

  if (!request.body) {
    return new Response("Empty body", { status: 400 });
  }

  await mkdir(path.dirname(filePath), { recursive: true });

  // `pipeline` ensures the write stream is closed even if the upload
  // is aborted mid-stream, and surfaces backpressure errors as a
  // rejected promise. Casting the request body to the Node web
  // ReadableStream type lets `Readable.fromWeb` accept it without TS
  // complaining about the DOM/Node `ReadableStream` mismatch.
  await pipeline(
    Readable.fromWeb(
      request.body as unknown as NodeWebReadableStream<Uint8Array>
    ),
    createWriteStream(filePath)
  );

  return new Response(null, { status: 200 });
}
