import type { ZodType } from "zod";
import { z } from "zod";

/** Convert a Zod field record (MCP `inputSchema` / `argsSchema`) to JSON Schema. */
export function zodRecordToJsonSchema(
  fields: Record<string, ZodType> | undefined
): Record<string, unknown> {
  return z.toJSONSchema(z.object(fields ?? {})) as Record<string, unknown>;
}

/** Convert a whole Zod schema (tool `outputSchema`) to JSON Schema. */
export function zodTypeToJsonSchema(schema: ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
