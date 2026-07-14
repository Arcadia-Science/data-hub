import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { authorize } from "@/lib/api/auth";
import { apiError, CONFLICT } from "@/lib/api/errors";
import { createInstrumentBody, readJsonBody } from "@/lib/api/openapi";
import { db } from "@/lib/db";
import { instruments } from "@/lib/db/schema";

export async function GET(request: NextRequest) {
  const authResult = await authorize(request, "instruments:read");
  if (authResult instanceof Response) {
    return authResult;
  }

  const rows = await db
    .select({
      id: instruments.id,
      display_name: instruments.displayName,
      status: instruments.status,
      instrument_type: instruments.instrumentType,
    })
    .from(instruments);

  return Response.json(rows);
}

export async function POST(request: NextRequest) {
  const authResult = await authorize(request, "instruments:write");
  if (authResult instanceof Response) {
    return authResult;
  }

  const body = await readJsonBody(request, createInstrumentBody);
  if (body instanceof Response) {
    return body;
  }
  const id = body.id;

  const existing = await db
    .select({ id: instruments.id })
    .from(instruments)
    .where(eq(instruments.id, id))
    .limit(1);

  if (existing.length > 0) {
    return apiError(409, CONFLICT, `Instrument '${id}' already exists`);
  }

  // Default display name is derived from the kebab-case ID:
  // "spectramax-id3-plate-reader" → "Spectramax Id3 Plate Reader"
  // `display_name` is trimmed by the schema; empty string means "use default".
  const displayName = body.display_name
    ? body.display_name
    : id
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");

  const instrumentType = body.instrument_type ?? "generic";

  const [created] = await db
    .insert(instruments)
    .values({ id, displayName, status: "pending", instrumentType })
    .returning({
      id: instruments.id,
      display_name: instruments.displayName,
      status: instruments.status,
      instrument_type: instruments.instrumentType,
      created_at: instruments.createdAt,
    });

  return Response.json(created, { status: 201 });
}
