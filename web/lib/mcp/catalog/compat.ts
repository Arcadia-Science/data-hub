import { openOutputJsonSchema } from "@/lib/mcp/catalog/json-schema";

type JsonSchema = Record<string, unknown>;

/** The part of a catalog document that `findBreakingChanges` reads. */
export interface CatalogSchemas {
  tools: Array<{
    name: string;
    inputSchema: JsonSchema;
    outputSchema: JsonSchema;
  }>;
}

/**
 * Which way a schema may change without breaking a client that holds the older
 * tool list.
 *
 * - `output`: the client checks each response against its old schema, so every
 *   response head can send must still fit the base schema.
 * - `input`: the client sends what the base schema allows, so head must still
 *   accept all of it.
 */
type Direction = "input" | "output";

const UNION_KEYWORDS = ["oneOf", "anyOf"] as const;

/**
 * Find the changes between two MCP catalog documents that break a client
 * holding the base tool list. Each finding reads `tool › path: what changed`.
 *
 * Output schemas are opened first (see `openOutputJsonSchema`), so extra
 * fields and new string enum values are never findings, whether or not a
 * snapshot already holds the open form.
 *
 * Output schemas break when a tool is removed, a required property is removed
 * or made optional, a node accepts a type it did not before (including
 * `null`) or a union gains a member, a `const` changes or is dropped, or a
 * limit loosens: a bound, length, or item count, a `pattern`, or a `format`.
 *
 * Input schemas break when a property is removed, a property becomes required
 * or a new required property appears, an enum value is removed or a plain
 * value becomes an enum, a `const` changes, a node accepts fewer types or a
 * union loses a member, or a limit tightens.
 *
 * Unions are compared member by member when both sides have the same number
 * of members. Otherwise only the direction counts: an output union that grows
 * or an input union that shrinks is a finding, and its members aren't compared.
 * A schema and its `.nullable()` form (`anyOf: [schema, { type: "null" }]`)
 * are compared inside the wrapper too.
 */
export function findBreakingChanges(
  base: CatalogSchemas,
  head: CatalogSchemas
): string[] {
  const findings: string[] = [];
  const headTools = new Map(head.tools.map((tool) => [tool.name, tool]));
  for (const baseTool of base.tools) {
    const headTool = headTools.get(baseTool.name);
    if (!headTool) {
      findings.push(`${baseTool.name}: tool removed`);
      continue;
    }
    const report = (path: string, change: string) =>
      findings.push(`${baseTool.name} › ${path}: ${change}`);
    compareSchemas(
      "input",
      baseTool.inputSchema,
      headTool.inputSchema,
      "input",
      report
    );
    compareSchemas(
      "output",
      openOutputJsonSchema(baseTool.outputSchema),
      openOutputJsonSchema(headTool.outputSchema),
      "output",
      report
    );
  }
  return findings;
}

type Report = (path: string, change: string) => void;

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareSchemas(
  direction: Direction,
  base: JsonSchema,
  head: JsonSchema,
  path: string,
  report: Report
): void {
  const baseMembers = unionMembers(base);
  const headMembers = unionMembers(head);

  if (baseMembers && headMembers && baseMembers.length === headMembers.length) {
    compareUnionMembers(direction, base, head, path, report);
    return;
  }
  if (baseMembers || headMembers) {
    // The sides have different shapes, so compare what they accept first.
    if (compareTypes(direction, base, head, path, report)) {
      return;
    }
    if (baseMembers && headMembers) {
      compareUnionSizes(direction, baseMembers, headMembers, path, report);
      return;
    }
    // One side may be the other wrapped in `.nullable()`. Compare what's
    // inside, so a change there, such as a removed enum value, still counts.
    // `null` itself was compared above.
    const baseInner = baseMembers
      ? nullableInner(baseMembers)
      : withoutNullType(base);
    const headInner = headMembers
      ? nullableInner(headMembers)
      : withoutNullType(head);
    if (baseInner && headInner) {
      compareSchemas(direction, baseInner, headInner, path, report);
    }
    return;
  }

  compareTypes(direction, base, head, path, report);
  compareConst(direction, base, head, path, report);
  if (direction === "input") {
    compareEnum(base, head, path, report);
  }
  compareLimits(direction, base, head, path, report);
  compareProperties(direction, base, head, path, report);
  compareChild(direction, base.items, head.items, `${path}[]`, report);
  compareChild(
    direction,
    base.additionalProperties,
    head.additionalProperties,
    `${path}.*`,
    report
  );
}

function compareUnionMembers(
  direction: Direction,
  base: JsonSchema,
  head: JsonSchema,
  path: string,
  report: Report
): void {
  const baseMembers = unionMembers(base) ?? [];
  const headMembers = unionMembers(head) ?? [];
  for (const [index, baseMember] of baseMembers.entries()) {
    const headMember = headMembers[index];
    if (isRecord(baseMember) && isRecord(headMember)) {
      compareSchemas(
        direction,
        baseMember,
        headMember,
        `${path}.${unionKeyword(base)}[${index}]`,
        report
      );
    }
  }
}

function compareChild(
  direction: Direction,
  base: unknown,
  head: unknown,
  path: string,
  report: Report
): void {
  if (isRecord(base) && isRecord(head)) {
    compareSchemas(direction, base, head, path, report);
  }
}

function unionKeyword(schema: JsonSchema): "oneOf" | "anyOf" | undefined {
  return UNION_KEYWORDS.find((keyword) => Array.isArray(schema[keyword]));
}

function unionMembers(schema: JsonSchema): unknown[] | undefined {
  const keyword = unionKeyword(schema);
  return keyword ? (schema[keyword] as unknown[]) : undefined;
}

/** The schema inside `anyOf: [schema, { type: "null" }]`, if that's the shape. */
function nullableInner(members: unknown[]): JsonSchema | undefined {
  const rest = members.filter(
    (member) => !(isRecord(member) && member.type === "null")
  );
  const [inner] = rest;
  return rest.length === 1 && members.length > 1 && isRecord(inner)
    ? inner
    : undefined;
}

/**
 * The schema without `null` in its `type` list. Zod writes a nullable string
 * as `type: ["string", "null"]` but a nullable enum or object as an `anyOf`.
 */
function withoutNullType(schema: JsonSchema): JsonSchema {
  if (!(Array.isArray(schema.type) && schema.type.includes("null"))) {
    return schema;
  }
  const types = schema.type.filter((type) => type !== "null");
  return { ...schema, type: types.length === 1 ? types[0] : types };
}

function compareUnionSizes(
  direction: Direction,
  baseMembers: unknown[],
  headMembers: unknown[],
  path: string,
  report: Report
): void {
  if (direction === "output" && headMembers.length > baseMembers.length) {
    report(path, "union gained a member");
  }
  if (direction === "input" && headMembers.length < baseMembers.length) {
    report(path, "union lost a member");
  }
}

function compareProperties(
  direction: Direction,
  base: JsonSchema,
  head: JsonSchema,
  path: string,
  report: Report
): void {
  if (!(isRecord(base.properties) && isRecord(head.properties))) {
    return;
  }
  const baseProperties = base.properties;
  const headProperties = head.properties;
  const baseRequired = stringList(base.required);
  const headRequired = stringList(head.required);

  for (const [name, baseProperty] of Object.entries(baseProperties)) {
    const propertyPath = `${path}.${name}`;
    const headProperty = headProperties[name];

    if (direction === "output") {
      if (baseRequired.has(name) && !headRequired.has(name)) {
        report(
          propertyPath,
          headProperty === undefined
            ? "required property removed"
            : "required property is now optional"
        );
      }
    } else if (headProperty === undefined) {
      report(propertyPath, "property removed");
    }

    if (isRecord(baseProperty) && isRecord(headProperty)) {
      compareSchemas(
        direction,
        baseProperty,
        headProperty,
        propertyPath,
        report
      );
    }
  }

  if (direction === "input") {
    for (const name of headRequired) {
      if (baseRequired.has(name)) {
        continue;
      }
      report(
        `${path}.${name}`,
        name in baseProperties
          ? "property is now required"
          : "new required property"
      );
    }
  }
}

function stringList(value: unknown): Set<string> {
  return new Set(
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : []
  );
}

function compareConst(
  direction: Direction,
  base: JsonSchema,
  head: JsonSchema,
  path: string,
  report: Report
): void {
  const hasBase = "const" in base;
  const hasHead = "const" in head;
  if (hasBase && hasHead && !sameValue(base.const, head.const)) {
    report(
      path,
      `const changed from ${show(base.const)} to ${show(head.const)}`
    );
  } else if (hasBase && !hasHead && direction === "output") {
    report(path, `const ${show(base.const)} dropped`);
  } else if (!hasBase && hasHead && direction === "input") {
    report(path, `now accepts only ${show(head.const)}`);
  }
}

function compareEnum(
  base: JsonSchema,
  head: JsonSchema,
  path: string,
  report: Report
): void {
  const headValues = Array.isArray(head.enum) ? head.enum : undefined;
  if (!headValues) {
    return;
  }
  let baseValues: unknown[] | undefined;
  if (Array.isArray(base.enum)) {
    baseValues = base.enum;
  } else if ("const" in base) {
    baseValues = [base.const];
  }
  if (!baseValues) {
    report(path, `now accepts only ${headValues.map(show).join(", ")}`);
    return;
  }
  for (const value of baseValues) {
    if (!headValues.some((headValue) => sameValue(headValue, value))) {
      report(path, `enum value ${show(value)} removed`);
    }
  }
}

// Keywords that cap a value from above, and from below.
const UPPER_LIMITS = [
  "maximum",
  "exclusiveMaximum",
  "maxLength",
  "maxItems",
] as const;
const LOWER_LIMITS = [
  "minimum",
  "exclusiveMinimum",
  "minLength",
  "minItems",
] as const;

/**
 * A node's limit, or `none` when it has none. Zod gives every `.int()` the
 * safe-integer range, so a limit that far out counts as none.
 */
function limitOf(schema: JsonSchema, keyword: string, none: number): number {
  const value = schema[keyword];
  return typeof value === "number" && Math.abs(value) < Number.MAX_SAFE_INTEGER
    ? value
    : none;
}

/**
 * Reports limits that reject a value the other side allows: a bound, length,
 * or item count, a `pattern`, or a `format`. An input must not tighten them,
 * and an output must not loosen them.
 */
function compareLimits(
  direction: Direction,
  base: JsonSchema,
  head: JsonSchema,
  path: string,
  report: Report
): void {
  // The receiver must accept every value the sender's schema allows.
  const [sender, receiver] =
    direction === "input" ? [base, head] : [head, base];
  const changes: string[] = [];
  const describe = (keyword: string, none: number) => {
    const before = limitOf(base, keyword, none);
    const after = limitOf(head, keyword, none);
    return `${keyword} ${Number.isFinite(before) ? before : "none"} → ${Number.isFinite(after) ? after : "none"}`;
  };
  for (const keyword of UPPER_LIMITS) {
    const none = Number.POSITIVE_INFINITY;
    if (limitOf(receiver, keyword, none) < limitOf(sender, keyword, none)) {
      changes.push(describe(keyword, none));
    }
  }
  for (const keyword of LOWER_LIMITS) {
    const none = Number.NEGATIVE_INFINITY;
    if (limitOf(receiver, keyword, none) > limitOf(sender, keyword, none)) {
      changes.push(describe(keyword, none));
    }
  }
  if (receiver.format !== undefined && receiver.format !== sender.format) {
    changes.push(
      `format ${showOptional(base.format)} → ${showOptional(head.format)}`
    );
  }
  // Zod pairs each string format with a pattern of its own, which can change
  // between Zod versions, so a pattern counts only where there's no format.
  if (
    receiver.pattern !== undefined &&
    receiver.format === undefined &&
    receiver.pattern !== sender.pattern
  ) {
    changes.push(`pattern ${patternChange(base, head)}`);
  }
  if (changes.length > 0) {
    report(path, `limits changed: ${changes.join(", ")}`);
  }
}

function patternChange(base: JsonSchema, head: JsonSchema): string {
  if (base.pattern === undefined) {
    return "added";
  }
  return head.pattern === undefined ? "removed" : "changed";
}

function showOptional(value: unknown): string {
  return value === undefined ? "none" : show(value);
}

/**
 * The JSON types a node accepts, or `undefined` when it names none (so it
 * accepts any). A union accepts what its members accept.
 */
function acceptedTypes(schema: JsonSchema): Set<string> | undefined {
  if (typeof schema.type === "string") {
    return new Set([schema.type]);
  }
  if (Array.isArray(schema.type)) {
    return new Set(schema.type.filter((t) => typeof t === "string"));
  }
  if ("const" in schema) {
    return new Set([jsonTypeOf(schema.const)]);
  }
  if (Array.isArray(schema.enum)) {
    return new Set(schema.enum.map(jsonTypeOf));
  }
  const members = unionMembers(schema);
  if (!members) {
    return;
  }
  const types = new Set<string>();
  for (const member of members) {
    const memberTypes = isRecord(member) ? acceptedTypes(member) : undefined;
    if (!memberTypes) {
      return;
    }
    for (const type of memberTypes) {
      types.add(type);
    }
  }
  return types;
}

function jsonTypeOf(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

// Every integer is a number, so `number` covers `integer` but not the reverse.
function covers(types: Set<string>, type: string): boolean {
  return types.has(type) || (type === "integer" && types.has("number"));
}

/** Reports a change in the types a node accepts. Returns whether it did. */
function compareTypes(
  direction: Direction,
  base: JsonSchema,
  head: JsonSchema,
  path: string,
  report: Report
): boolean {
  const baseTypes = acceptedTypes(base);
  const headTypes = acceptedTypes(head);

  if (direction === "output") {
    // Head may send what base would reject.
    if (!baseTypes) {
      return false;
    }
    if (!headTypes) {
      report(path, "no longer limits the type");
      return true;
    }
    const added = [...headTypes].filter((type) => !covers(baseTypes, type));
    if (added.length > 0) {
      report(path, `now also accepts ${added.join(", ")}`);
    }
    return added.length > 0;
  }

  // Head may reject what base would accept.
  if (!headTypes) {
    return false;
  }
  if (!baseTypes) {
    report(path, `now accepts only ${[...headTypes].join(", ")}`);
    return true;
  }
  const removed = [...baseTypes].filter((type) => !covers(headTypes, type));
  if (removed.length > 0) {
    report(path, `no longer accepts ${removed.join(", ")}`);
  }
  return removed.length > 0;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function show(value: unknown): string {
  return JSON.stringify(value);
}
