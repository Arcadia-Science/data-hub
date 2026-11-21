import type { NextRequest } from "next/server";
import { actorRefFromAuth } from "@/lib/api/actor";
import { authorize } from "@/lib/api/auth";
import {
  apiError,
  apiErrorFromResult,
  NOT_FOUND,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { restoreFiles } from "@/lib/api/file-deletion";
import { linkedRestoreToWire, restoredFileToWire } from "@/lib/api/file-wire";
import { enforceWatcherTokenFile } from "@/lib/api/watchers";

interface RouteContext {
  params: Promise<{ fileId: string }>;
}

// ---------------------------------------------------------------------------
// POST /api/v1/files/:fileId/restore
//
// Brings a deleted file back to its run and clears who deleted it. A file whose
// name or path another file of the run now holds is refused (409,
// `details.reason: "path_in_use"`, with `details.held_by` naming that file), and
// so is any file of a deleted run. Restoring a file that isn't deleted succeeds
// with `already_applied`.
//
// `?include_linked=true` restores the deleted files linked to it too. The
// response lists them in `linked`, each with its own result, because one of them
// can be refused while the file itself comes back.
//
// Needs `files:delete`, the scope that deletes, the way restoring a run needs
// `runs:delete`. A token that registered a watcher may restore only its own
// instrument's files.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authorize(request, "files:delete");
  if (authResult instanceof Response) {
    return authResult;
  }

  const { fileId } = await params;
  const numericId = Number.parseInt(fileId, 10);
  if (Number.isNaN(numericId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid file ID");
  }

  const denied = await enforceWatcherTokenFile(authResult, numericId);
  if (denied) {
    return denied;
  }

  const { results, linked } = await restoreFiles(
    [numericId],
    actorRefFromAuth(authResult),
    {
      includeLinked:
        request.nextUrl.searchParams.get("include_linked") === "true",
    }
  );
  const [result] = results;

  if (!result?.ok) {
    return result
      ? apiErrorFromResult(result)
      : apiError(404, NOT_FOUND, `File '${fileId}' not found`);
  }

  return Response.json({
    ...restoredFileToWire(result),
    linked: linked.map(linkedRestoreToWire),
  });
}
