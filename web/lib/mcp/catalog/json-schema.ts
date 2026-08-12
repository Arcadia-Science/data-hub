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
  // Same options the MCP SDK uses for `tools/list`, so
  // `GET /mcp/v1/schema.json` stays aligned with the live wire shape.
  const json = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "output",
  }) as Record<string, unknown>;
  // Discriminated unions emit `oneOf` without `type`. The SDK stamps
  // `type: "object"` so 2025-era clients don't wrap the payload as
  // `{ result: ... }`.
  if (json.type === undefined && isObjectShapedJsonSchema(json)) {
    return { type: "object", ...json };
  }
  return json;
}

function isObjectShapedJsonSchema(schema: Record<string, unknown>): boolean {
  if (
    "properties" in schema ||
    "patternProperties" in schema ||
    "additionalProperties" in schema ||
    "required" in schema
  ) {
    return true;
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    const members = schema[key];
    if (Array.isArray(members) && members.length > 0) {
      return members.every(
        (member) =>
          member !== null &&
          typeof member === "object" &&
          ("type" in member
            ? member.type === "object"
            : isObjectShapedJsonSchema(member as Record<string, unknown>))
      );
    }
  }
  return false;
}
