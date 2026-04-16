import { authenticateRequest } from "@/lib/api/auth";
import { apiError, NOT_FOUND, UNAUTHORIZED } from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { db } from "@/lib/db";
import { files } from "@/lib/db/schema";
import { getS3ObjectStream } from "@/lib/s3";
import archiver from "archiver";
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { PassThrough, Readable } from "node:stream";

type RouteContext = {
  params: Promise<{ instrumentId: string; runId: string }>;
};

// ---------------------------------------------------------------------------
// GET /api/v1/instruments/:instrumentId/runs/:runId/download-archive
//
// Streams a zip archive containing all active, uploaded files for a run.
// Files are fetched from S3 and piped directly into the archive without
// buffering entire objects in memory.
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

  const fileRows = await db
    .select({
      id: files.id,
      filename: files.filename,
      s3Bucket: files.s3Bucket,
      s3Key: files.s3Key,
    })
    .from(files)
    .where(and(eq(files.instrumentRunId, run.id), isNull(files.deletedAt)));

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
