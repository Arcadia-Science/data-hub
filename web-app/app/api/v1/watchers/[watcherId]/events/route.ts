import { authenticateRequest } from "@/lib/api/auth";
import {
  apiError,
  NOT_FOUND,
  UNAUTHORIZED,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import {
  isValidUUID,
  parseDateParam,
  parseIntParam,
} from "@/lib/api/validators";
import { findActiveWatcher } from "@/lib/api/watchers";
import { db } from "@/lib/db";
import { watcherEvents } from "@/lib/db/schema";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { NextRequest } from "next/server";

const VALID_EVENT_TYPES = new Set([
  "watcher_started",
  "watcher_stopped",
  "file_uploaded",
  "upload_failed",
  "run_reported",
  "config_synced",
  "error",
]);

export async function POST(
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

  let body: { events?: unknown[] };
  try {
    body = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  if (!Array.isArray(body.events) || body.events.length === 0) {
    return apiError(
      400,
      VALIDATION_ERROR,
      "events array is required and must not be empty"
    );
  }

  if (body.events.length > 100) {
    return apiError(400, VALIDATION_ERROR, "Maximum 100 events per request");
  }

  type EventInput = {
    event_type: string;
    timestamp: string;
    message: string;
    details?: Record<string, unknown>;
  };

  const values = [];
  for (let i = 0; i < body.events.length; i++) {
    const evt = body.events[i] as EventInput;
    if (!evt.event_type || !evt.timestamp || !evt.message) {
      return apiError(
        400,
        VALIDATION_ERROR,
        `Event at index ${i} requires event_type, timestamp, and message`
      );
    }
    if (!VALID_EVENT_TYPES.has(evt.event_type)) {
      return apiError(
        400,
        VALIDATION_ERROR,
        `Invalid event_type '${evt.event_type}' at index ${i}`
      );
    }
    const ts = new Date(evt.timestamp);
    if (isNaN(ts.getTime())) {
      return apiError(400, VALIDATION_ERROR, `Invalid timestamp at index ${i}`);
    }
    values.push({
      watcherId,
      eventType: evt.event_type as typeof watcherEvents.$inferInsert.eventType,
      message: evt.message,
      details: evt.details ?? null,
      timestamp: ts,
    });
  }

  await db.insert(watcherEvents).values(values);

  return Response.json({ received: values.length }, { status: 201 });
}

export async function GET(
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

  const { searchParams } = request.nextUrl;
  const limit = parseIntParam(searchParams.get("limit"), {
    default: 50,
    min: 1,
    max: 500,
  });
  const since = parseDateParam(searchParams.get("since"));
  const eventTypeFilter = searchParams.get("event_type");

  const conditions = [eq(watcherEvents.watcherId, watcherId)];
  if (since) {
    conditions.push(gte(watcherEvents.timestamp, since));
  }
  if (eventTypeFilter) {
    // Accepts comma-separated types (e.g. "error,upload_failed");
    // silently drops unrecognized values to avoid 400s on typos.
    const types = eventTypeFilter
      .split(",")
      .filter((t) => VALID_EVENT_TYPES.has(t));
    if (types.length > 0) {
      conditions.push(
        inArray(
          watcherEvents.eventType,
          types as (typeof watcherEvents.$inferInsert.eventType)[]
        )
      );
    }
  }

  const rows = await db
    .select({
      id: watcherEvents.id,
      event_type: watcherEvents.eventType,
      message: watcherEvents.message,
      details: watcherEvents.details,
      timestamp: watcherEvents.timestamp,
      created_at: watcherEvents.createdAt,
    })
    .from(watcherEvents)
    .where(and(...conditions))
    .orderBy(desc(watcherEvents.timestamp))
    .limit(limit);

  return Response.json({ data: rows });
}
