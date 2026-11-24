import type { ZodType } from "zod";
import { z } from "zod";

type JsonSchema = Record<string, unknown>;

/** Convert a Zod field record (MCP `inputSchema` / `argsSchema`) to JSON Schema. */
export function zodRecordToJsonSchema(
  fields: Record<string, ZodType> | undefined
): Record<string, unknown> {
  return z.toJSONSchema(z.object(fields ?? {})) as Record<string, unknown>;
}

/**
 * Convert a whole Zod schema (tool `outputSchema`) to the JSON Schema we
 * publish: Zod's output schema, opened with `openOutputJsonSchema`.
 */
export function zodTypeToJsonSchema(schema: ZodType): Record<string, unknown> {
  // Same options the MCP SDK uses for `tools/list`, so
  // `GET /mcp/v1/schema.json` stays aligned with the live wire shape.
  const json = openOutputJsonSchema(
    z.toJSONSchema(schema, {
      target: "draft-2020-12",
      io: "output",
    }) as JsonSchema
  );
  // Discriminated unions emit `oneOf` without `type`. The SDK stamps
  // `type: "object"` so 2025-era clients don't wrap the payload as
  // `{ result: ... }`.
  if (json.type === undefined && isObjectShapedJsonSchema(json)) {
    return { type: "object", ...json };
  }
  return json;
}

// Keywords whose value is one schema, or a list of schemas in older drafts.
// `not` and `if` are left alone: opening them would reject more, not less.
const SINGLE_SCHEMA_KEYWORDS = new Set([
  "items",
  "additionalProperties",
  "propertyNames",
  "contains",
  "then",
  "else",
]);
// Keywords whose value is a record of schemas.
const SCHEMA_RECORD_KEYWORDS = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "$defs",
  "definitions",
]);
// Keywords whose value is a list of schemas.
const SCHEMA_LIST_KEYWORDS = new Set([
  "anyOf",
  "oneOf",
  "allOf",
  "prefixItems",
]);

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Open a tool output schema before we publish it.
 *
 * MCP clients keep the `tools/list` they fetched when they connected and check
 * every `structuredContent` against it. Zod closes every object with
 * `additionalProperties: false` and lists every enum value, so a field or
 * enum value added in a later release makes those clients reject the answer.
 * This function:
 *
 * - drops `additionalProperties: false`, so extra fields are allowed, and
 * - turns each string `enum` into the known values or any other string, so
 *   new values are allowed. The outer node keeps `description`, `deprecated`,
 *   and `title`.
 *
 * `const` is never touched: the `oneOf` members of `get_run_archive` and the
 * file delete and restore results are told apart by a `const`.
 *
 * The schema isn't mutated, and opening an open schema changes nothing. We
 * validate with the Zod schema, which stays closed, so only the published
 * schema is open. Don't use this for input schemas.
 */
export function openOutputJsonSchema(schema: JsonSchema): JsonSchema {
  return openNode(schema, true);
}

function openNode(node: JsonSchema, openEnum: boolean): JsonSchema {
  const opened: JsonSchema = {};
  for (const [keyword, value] of Object.entries(node)) {
    if (keyword === "additionalProperties" && value === false) {
      continue;
    }
    opened[keyword] = openKeyword(keyword, value);
  }
  return openEnum && isStringEnum(opened) ? openStringEnum(opened) : opened;
}

function openKeyword(keyword: string, value: unknown): unknown {
  if (SCHEMA_RECORD_KEYWORDS.has(keyword) && isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, child]) => [name, openChild(child)])
    );
  }
  if (SINGLE_SCHEMA_KEYWORDS.has(keyword)) {
    return Array.isArray(value) ? value.map(openChild) : openChild(value);
  }
  if (SCHEMA_LIST_KEYWORDS.has(keyword) && Array.isArray(value)) {
    // An `anyOf` that already lists a plain string next to an enum is open, so
    // leave its enum alone. That keeps this function from nesting twice.
    const alreadyOpen = keyword === "anyOf" && value.some(isPlainStringSchema);
    return value.map((member) =>
      isRecord(member) ? openNode(member, !alreadyOpen) : member
    );
  }
  return value;
}

function openChild(child: unknown): unknown {
  return isRecord(child) ? openNode(child, true) : child;
}

function isPlainStringSchema(schema: unknown): boolean {
  return (
    isRecord(schema) &&
    Object.keys(schema).length === 1 &&
    schema.type === "string"
  );
}

function isStringEnum(node: JsonSchema): boolean {
  return (
    Array.isArray(node.enum) &&
    node.enum.length > 0 &&
    node.enum.every((value) => typeof value === "string") &&
    (node.type === undefined || node.type === "string")
  );
}

function openStringEnum(node: JsonSchema): JsonSchema {
  const { type: _type, enum: values, ...annotations } = node;
  return {
    ...annotations,
    anyOf: [{ type: "string", enum: values }, { type: "string" }],
  };
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
