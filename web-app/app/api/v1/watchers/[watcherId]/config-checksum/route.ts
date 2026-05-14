import { authenticateRequest } from "@/lib/api/auth";
import {
  apiError,
  NOT_FOUND,
  UNAUTHORIZED,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { requireScope } from "@/lib/api/scopes";
import { isValidUUID } from "@/lib/api/validators";
import { findActiveWatcher } from "@/lib/api/watchers";
import type { NextRequest } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ watcherId: string }> }
) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }
  const scopeError = requireScope(authResult, "watchers:read");
  if (scopeError) return scopeError;

  const { watcherId } = await params;
  if (!isValidUUID(watcherId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid watcher ID format");
  }

  const watcher = await findActiveWatcher(watcherId);
  if (!watcher) {
    return apiError(404, NOT_FOUND, `Watcher '${watcherId}' not found`);
  }

  if (!watcher.configChecksum) {
    return apiError(
      404,
      NOT_FOUND,
      "No config has been pushed for this watcher"
    );
  }

  return Response.json({ config_checksum: watcher.configChecksum });
}
