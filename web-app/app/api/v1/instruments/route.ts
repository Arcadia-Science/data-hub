import { authenticateRequest } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  UNAUTHORIZED,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { isValidKebabCase } from "@/lib/api/validators";
import { db } from "@/lib/db";
import { instruments } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const rows = await db
    .select({
      id: instruments.id,
      display_name: instruments.displayName,
      status: instruments.status,
      file_patterns: instruments.filePatterns,
      s3_trigger_suffix: instruments.s3TriggerSuffix,
    })
    .from(instruments);

  return Response.json(rows);
}

export async function POST(request: NextRequest) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  let body: { id?: string; display_name?: string };
  try {
    body = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) {
    return apiError(400, VALIDATION_ERROR, "id is required");
  }
  if (!isValidKebabCase(id)) {
    return apiError(
      400,
      VALIDATION_ERROR,
      "id must be lowercase kebab-case (e.g., my-instrument)"
    );
  }

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
  const displayName =
    typeof body.display_name === "string" && body.display_name.trim()
      ? body.display_name.trim()
      : id
          .split("-")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ");

  // New instruments start as "pending" until confirmed by an admin.
  const [created] = await db
    .insert(instruments)
    .values({ id, displayName, status: "pending" })
    .returning({
      id: instruments.id,
      display_name: instruments.displayName,
      status: instruments.status,
      file_patterns: instruments.filePatterns,
      s3_trigger_suffix: instruments.s3TriggerSuffix,
      created_at: instruments.createdAt,
    });

  return Response.json(created, { status: 201 });
}
