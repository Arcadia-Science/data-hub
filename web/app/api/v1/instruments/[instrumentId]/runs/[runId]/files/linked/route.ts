import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import {
  apiError,
  apiErrorFromResult,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { findRunLinkedFiles } from "@/lib/api/file-batch";
import { linkedFilesToWire } from "@/lib/api/file-wire";
import { readRunIdParam } from "@/lib/api/run-id-param";
import { enforceWatcherTokenInstrument } from "@/lib/api/watchers";
import { FILE_ACTION_IDS_MAX } from "@/lib/runs/file-action-limits";

interface RouteContext {
  params: Promise<{ instrumentId: string; runId: string }>;
}

// ---------------------------------------------------------------------------
// GET /api/v1/instruments/:instrumentId/runs/:runId/files/linked
//   ?file_ids=1,2&for=delete|restore
//
// The files that a delete (the default) or a restore would take along with each
// of the files asked about, grouped by that file, so a dialog can show them
// before anyone acts. It changes nothing. An ID that isn't a file of this run
// is left out. Needs `files:delete`, like the actions it previews.
// ---------------------------------------------------------------------------

const FILE_ID = /^[1-9]\d*$/;

function parseFileIds(value: string | null): number[] | null {
  const parts = (value ?? "").split(",").map((part) => part.trim());
  if (
    parts.length > FILE_ACTION_IDS_MAX ||
    !parts.every((part) => FILE_ID.test(part))
  ) {
    return null;
  }
  const ids = parts.map((part) => Number.parseInt(part, 10));
  // `files.id` is a bigint. A number past 2^53 can't name one exactly.
  return ids.every((id) => Number.isSafeInteger(id)) ? ids : null;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "files:delete");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { instrumentId, runId: runIdParam } = await params;
  const denied = await enforceWatcherTokenInstrument(authResult, instrumentId);
  if (denied) {
    return denied;
  }
  const runId = readRunIdParam(request.headers, runIdParam);

  const { searchParams } = request.nextUrl;
  const fileIds = parseFileIds(searchParams.get("file_ids"));
  if (!fileIds) {
    return apiError(
      400,
      VALIDATION_ERROR,
      `file_ids must be 1 to ${FILE_ACTION_IDS_MAX} comma-separated file IDs`
    );
  }
  const mode = searchParams.get("for") ?? "delete";
  if (mode !== "delete" && mode !== "restore") {
    return apiError(400, VALIDATION_ERROR, "for must be delete or restore");
  }

  const result = await findRunLinkedFiles({
    instrumentId,
    runId,
    fileIds,
    mode,
  });
  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  return Response.json({
    instrument_id: result.instrumentId,
    run_id: result.runId,
    groups: linkedFilesToWire(result.groups),
  });
}
