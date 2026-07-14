import type { z } from "zod";
import { apiError, VALIDATION_ERROR } from "@/lib/api/errors";

export async function readJsonBody<T>(
  request: Request,
  schema: z.ZodType<T>
): Promise<T | Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue
      ? `${issue.path.length ? `${issue.path.join(".")}: ` : ""}${issue.message}`
      : "Invalid request body";
    return apiError(400, VALIDATION_ERROR, message, {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}
