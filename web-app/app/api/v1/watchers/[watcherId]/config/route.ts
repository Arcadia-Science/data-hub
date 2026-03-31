import { authenticateRequest } from "@/lib/api/auth";
import {
  apiError,
  NOT_FOUND,
  UNAUTHORIZED,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { isValidUUID } from "@/lib/api/validators";
import { findActiveWatcher } from "@/lib/api/watchers";
import { db } from "@/lib/db";
import { watchers } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ watcherId: string }> }
) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const { watcherId } = await params;
  if (!isValidUUID(watcherId)) {
    return apiError(400, NOT_FOUND, "Invalid watcher ID format");
  }

  const watcher = await findActiveWatcher(watcherId);
  if (!watcher) {
    return apiError(404, NOT_FOUND, `Watcher '${watcherId}' not found`);
  }

  let body: { config_checksum?: string; config_yaml?: string };
  try {
    body = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  if (
    typeof body.config_checksum !== "string" ||
    typeof body.config_yaml !== "string"
  ) {
    return apiError(
      400,
      VALIDATION_ERROR,
      "config_checksum and config_yaml are required"
    );
  }

  await db
    .update(watchers)
    .set({
      configChecksum: body.config_checksum,
      configYaml: body.config_yaml,
    })
    .where(eq(watchers.id, watcherId));

  return Response.json({ config_checksum: body.config_checksum });
}
