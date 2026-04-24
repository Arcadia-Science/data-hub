import { authenticateRequest } from "@/lib/api/auth";
import { apiError, NOT_FOUND, UNAUTHORIZED } from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { db } from "@/lib/db";
import { files } from "@/lib/db/schema";
import { getS3ObjectStream } from "@/lib/s3";
import archiver from "archiver";
import { and, eq, inArray, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { PassThrough, Readable } from "node:stream";

type RouteContext = {
  params: Promise<{ instrumentId: string; runId: string }>;
};

// Parse `?file_ids=1,2,3` (or repeated `?file_ids=1&file_ids=2`) into a
// deduped array of positive integers. Anything malformed is silently dropped
// so the request still resolves against whatever valid IDs were supplied.
function parseFileIdsParam(searchParams: URLSearchParams): number[] | null {
  const raw = searchParams.getAll("file_ids");
  if (raw.length === 0) return null;
  const ids = new Set<number>();
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const n = Number.parseInt(part.trim(), 10);
      if (Number.isInteger(n) && n > 0) ids.add(n);
    }
  }
  return ids.size > 0 ? Array.from(ids) : [];
}

// ---------------------------------------------------------------------------
// GET /api/v1/instruments/:instrumentId/runs/:runId/download-archive
//
// Streams a zip archive containing all active, uploaded files for a run.
// Files are fetched from S3 and piped directly into the archive without
// buffering entire objects in memory.
//
// Optional `?file_ids=1,2,3` narrows the archive to a specific subset (used
// by the UI's "Download all" button to honor active table filters). IDs are
// always intersected with the run's own files, so callers can't reach files
// belonging to other runs.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, { params }: RouteContext) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const { instrumentId, runId } = await params;
  const run = await lookupRunByNaturalKey(instrumentId, runId);

  if (!run) {
    return apiError(
      404,
      NOT_FOUND,
      `Run '${runId}' not found for instrument '${instrumentId}'`
    );
  }

  const fileIdsFilter = parseFileIdsParam(request.nextUrl.searchParams);

  const conditions = [
    eq(files.instrumentRunId, run.id),
    isNull(files.deletedAt),
  ];
  if (fileIdsFilter !== null) {
    if (fileIdsFilter.length === 0) {
      return apiError(404, NOT_FOUND, "No downloadable files for this run");
    }
    conditions.push(inArray(files.id, fileIdsFilter));
  }

  const fileRows = await db
    .select({
      id: files.id,
      filename: files.filename,
      s3Bucket: files.s3Bucket,
      s3Key: files.s3Key,
    })
    .from(files)
    .where(and(...conditions));

  const downloadable = fileRows.filter((f) => f.s3Bucket && f.s3Key);

  if (downloadable.length === 0) {
    return apiError(404, NOT_FOUND, "No downloadable files for this run");
  }

  const passthrough = new PassThrough();
  const archive = archiver("zip", { store: true });
  archive.pipe(passthrough);

  // Append files in the background — errors surface via the archive's error
  // event which aborts the passthrough stream.
  (async () => {
    try {
      for (const file of downloadable) {
        const stream = await getS3ObjectStream(file.s3Bucket!, file.s3Key!);
        archive.append(stream, { name: file.filename });
      }
      await archive.finalize();
    } catch (err) {
      console.error("Archive streaming failed:", err);
      archive.abort();
    }
  })();

  const webStream = Readable.toWeb(passthrough) as ReadableStream;
  const safeRunId = runId.replace(/[^a-zA-Z0-9._-]/g, "_");

  return new Response(webStream, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${safeRunId}.zip"`,
    },
  });
}
