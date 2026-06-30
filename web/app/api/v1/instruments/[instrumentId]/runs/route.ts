import { and, eq, isNull, sql } from "drizzle-orm";
import { after, type NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { buildRunListQuery, parseAcquiredAt } from "@/lib/api/instrument-runs";
import { notifyRunCreated } from "@/lib/api/notifications";
import { parseIntParam } from "@/lib/api/validators";
import { db } from "@/lib/db";
import { files, instrumentRuns, instruments, watchers } from "@/lib/db/schema";
import { sendSlackMessage } from "@/lib/slack";

interface RouteContext {
  params: Promise<{ instrumentId: string }>;
}

// ---------------------------------------------------------------------------
// POST /api/v1/instruments/:instrumentId/runs
//
// Idempotent run creation. Two callers use different payloads:
//   - Lambda: { run_id, source: "lambda" }
//   - Watcher: { run_id, source: "watcher", watcher_id, detected_files[] }
// If the run already exists (same instrument_id + run_id), returns 200 with
// the existing record instead of 201. This handles the race where a Lambda
// auto-creates a run that was already reported by the watcher.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:write");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { instrumentId } = await params;

  const [instrument] = await db
    .select({ id: instruments.id, displayName: instruments.displayName })
    .from(instruments)
    .where(eq(instruments.id, instrumentId))
    .limit(1);

  if (!instrument) {
    return apiError(404, NOT_FOUND, `Instrument '${instrumentId}' not found`);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  const runId = typeof body.run_id === "string" ? body.run_id.trim() : "";
  if (!runId) {
    return apiError(400, VALIDATION_ERROR, "run_id is required");
  }

  const source = body.source;
  if (source !== "lambda" && source !== "watcher") {
    return apiError(
      400,
      VALIDATION_ERROR,
      'source must be "lambda" or "watcher"'
    );
  }

  const watcherId =
    typeof body.watcher_id === "string" ? body.watcher_id : null;

  // Parse the watcher-supplied acquired_at, falling back to the floor of
  // any detected_files[].file_created_at when omitted. This is defense-in-
  // depth: older watchers or future callers that send only file timestamps
  // still get a meaningful run-level acquisition timestamp on insert.
  const incomingAcquiredAt = parseAcquiredAt(body);

  // Validate watcher_id references an active watcher for this instrument.
  if (watcherId) {
    const [watcher] = await db
      .select({ id: watchers.id })
      .from(watchers)
      .where(
        and(
          eq(watchers.id, watcherId),
          eq(watchers.instrumentId, instrumentId),
          isNull(watchers.deletedAt)
        )
      )
      .limit(1);

    if (!watcher) {
      return apiError(
        400,
        VALIDATION_ERROR,
        `Watcher '${watcherId}' not found or not active for this instrument`
      );
    }
  }

  // Upsert: attempt insert, do nothing on conflict. Then select the row
  // regardless of whether it was just created or already existed.
  const [inserted] = await db
    .insert(instrumentRuns)
    .values({
      instrumentId,
      runId,
      source,
      watcherId,
      acquiredAt: incomingAcquiredAt,
    })
    .onConflictDoNothing({
      target: [instrumentRuns.instrumentId, instrumentRuns.runId],
    })
    .returning({ id: instrumentRuns.id });

  const isNew = !!inserted;

  // If onConflictDoNothing fired, `inserted` is undefined — fetch the
  // existing row by the natural key. When the watcher POST races a
  // lambda-created row, fold the watcher's acquired_at into the existing
  // row using LEAST so it can only ever move earlier.
  const [run] = isNew
    ? await db
        .select()
        .from(instrumentRuns)
        .where(eq(instrumentRuns.id, inserted.id))
        .limit(1)
    : await db
        .select()
        .from(instrumentRuns)
        .where(
          and(
            eq(instrumentRuns.instrumentId, instrumentId),
            eq(instrumentRuns.runId, runId)
          )
        )
        .limit(1);

  if (!isNew && incomingAcquiredAt) {
    // Bind the ISO string explicitly + cast to timestamptz: drizzle's
    // sql tag has no PgColumn context here to type a JS Date interpolated
    // into a raw fragment. See instrument-runs.ts dateFrom/dateTo for
    // the same pattern.
    const iso = incomingAcquiredAt.toISOString();
    await db
      .update(instrumentRuns)
      .set({
        acquiredAt: sql`least(coalesce(${instrumentRuns.acquiredAt}, ${iso}::timestamptz), ${iso}::timestamptz)`,
      })
      .where(eq(instrumentRuns.id, run.id));
  }

  // Watcher payloads may include detected files to bulk-insert alongside
  // the run. Duplicates (same run + relative_path) are silently skipped.
  const detectedFiles = Array.isArray(body.detected_files)
    ? body.detected_files
    : [];

  if (detectedFiles.length > 0) {
    const now = new Date();
    const fileValues = detectedFiles.map(
      (f: {
        relative_path: string;
        filename: string;
        size_bytes?: number;
        file_created_at?: string;
      }) => ({
        instrumentRunId: run.id,
        relativePath: f.relative_path,
        filename: f.filename,
        sizeBytes: f.size_bytes ?? null,
        status: "detected" as const,
        detectedAt: now,
        fileCreatedAt:
          typeof f.file_created_at === "string"
            ? new Date(f.file_created_at)
            : null,
      })
    );

    // Relies on the partial unique index (instrument_run_id, relative_path)
    // to skip files already reported in a previous request for this run.
    await db.insert(files).values(fileValues).onConflictDoNothing();
  }

  // Send Slack channel notification and fan out per-user notifications.
  if (isNew) {
    after(async () => {
      const origin = new URL(request.url).origin;
      await sendSlackMessage(
        `*${instrument.displayName}*\n` +
          `New instrument run reported: \`${runId}\`.\n` +
          `<${origin}/instruments/${instrumentId}/runs/${encodeURIComponent(runId)}|View in Data Hub>`
      );

      await notifyRunCreated({
        runInternalId: run.id,
        instrumentId,
        instrumentDisplayName: instrument.displayName,
        runDisplayId: runId,
        origin,
      });
    });
  }

  return Response.json(
    {
      id: run.id,
      instrument_id: run.instrumentId,
      run_id: run.runId,
      source: run.source,
    },
    { status: isNew ? 201 : 200 }
  );
}

// ---------------------------------------------------------------------------
// GET /api/v1/instruments/:instrumentId/runs
//
// Paginated list with file count aggregation. Delegates to the shared
// buildRunListQuery helper so the cross-instrument endpoint can reuse it.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "runs:read");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { instrumentId } = await params;

  const [instrument] = await db
    .select({ id: instruments.id })
    .from(instruments)
    .where(eq(instruments.id, instrumentId))
    .limit(1);

  if (!instrument) {
    return apiError(404, NOT_FOUND, `Instrument '${instrumentId}' not found`);
  }

  const { searchParams } = request.nextUrl;

  const result = await buildRunListQuery({
    instrumentId,
    source: searchParams.get("source") ?? undefined,
    search: searchParams.get("search") ?? undefined,
    sort: searchParams.get("sort") ?? undefined,
    order: searchParams.get("order") ?? undefined,
    dateFrom: searchParams.get("date_from") ?? undefined,
    dateTo: searchParams.get("date_to") ?? undefined,
    page: parseIntParam(searchParams.get("page"), {
      default: 1,
      min: 1,
    }),
    perPage: parseIntParam(searchParams.get("per_page"), {
      default: 10,
      min: 1,
      max: 100,
    }),
    includeDeleted: searchParams.get("include_deleted") === "true",
    ranBy: searchParams.get("ran_by") ?? undefined,
  });

  return Response.json(result);
}
