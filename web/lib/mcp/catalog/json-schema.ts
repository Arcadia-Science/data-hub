import type { ZodType } from "zod";
import { z } from "zod";

/** Convert a Zod field record (MCP `inputSchema` / `argsSchema`) to JSON Schema. */
export function zodRecordToJsonSchema(
  fields: Record<string, ZodType> | undefined
): Record<string, unknown> {
  if (!fields || Object.keys(fields).length === 0) {
    return {
      type: "object",
      properties: {},
    };
  }
  return z.toJSONSchema(z.object(fields)) as Record<string, unknown>;
}
