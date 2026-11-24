import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildMcpCatalogDocument, MCP_TOOL_DEFS } from "@/lib/mcp/catalog";
import {
  type CatalogSchemas,
  findBreakingChanges,
} from "@/lib/mcp/catalog/compat";
import { openOutputJsonSchema } from "@/lib/mcp/catalog/json-schema";
import beforeLabNotebooks from "./fixtures/mcp-catalog-before-lab-notebooks.json";

type JsonSchema = Record<string, unknown>;

const EMPTY_OBJECT: JsonSchema = { type: "object", properties: {} };

function catalog(
  tools: Record<string, { input?: JsonSchema; output?: JsonSchema }>
): CatalogSchemas {
  return {
    tools: Object.entries(tools).map(([name, { input, output }]) => ({
      name,
      inputSchema: input ?? EMPTY_OBJECT,
      outputSchema: output ?? EMPTY_OBJECT,
    })),
  };
}

function object(
  properties: Record<string, JsonSchema>,
  required: string[] = Object.keys(properties)
): JsonSchema {
  return { type: "object", properties, required };
}

/** Compare one tool whose output (or input) changes from `base` to `head`. */
function outputBreaks(base: JsonSchema, head: JsonSchema): string[] {
  return findBreakingChanges(
    catalog({ t: { output: base } }),
    catalog({ t: { output: head } })
  );
}

function inputBreaks(base: JsonSchema, head: JsonSchema): string[] {
  return findBreakingChanges(
    catalog({ t: { input: base } }),
    catalog({ t: { input: head } })
  );
}

const STRING: JsonSchema = { type: "string" };
const NULLABLE_STRING: JsonSchema = { type: ["string", "null"] };

describe("openOutputJsonSchema", () => {
  const strict: JsonSchema = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["queued", "done"] },
      owner: {
        type: "object",
        properties: { name: { type: "string" } },
        additionalProperties: false,
      },
      rows: {
        type: "array",
        items: {
          type: "object",
          properties: { kind: { type: "string", enum: ["a"] } },
          additionalProperties: false,
        },
      },
      tags: {
        type: "object",
        propertyNames: { type: "string" },
        additionalProperties: { type: "string", enum: ["x"] },
      },
    },
    additionalProperties: false,
  };

  it("drops additionalProperties:false at every depth", () => {
    const open = openOutputJsonSchema(strict);
    const text = JSON.stringify(open);
    expect(text).not.toContain('"additionalProperties":false');
    // A schema-valued additionalProperties (a record) stays.
    expect(
      (open.properties as Record<string, JsonSchema>).tags.additionalProperties
    ).toBeDefined();
  });

  it("turns a string enum into the known values or any string", () => {
    const open = openOutputJsonSchema(strict);
    const properties = open.properties as Record<string, JsonSchema>;
    expect(properties.status).toEqual({
      anyOf: [{ type: "string", enum: ["queued", "done"] }, { type: "string" }],
    });
    const rowKind = (
      (properties.rows.items as JsonSchema).properties as Record<
        string,
        JsonSchema
      >
    ).kind;
    expect(rowKind.anyOf).toEqual([
      { type: "string", enum: ["a"] },
      { type: "string" },
    ]);
    expect(
      (properties.tags.additionalProperties as JsonSchema).anyOf
    ).toBeDefined();
  });

  it("keeps description, deprecated, and title on the outer node", () => {
    const open = openOutputJsonSchema({
      type: "string",
      enum: ["a", "b"],
      title: "Kind",
      description: "Deprecated. Use `type`.",
      deprecated: true,
    });
    expect(open).toEqual({
      title: "Kind",
      description: "Deprecated. Use `type`.",
      deprecated: true,
      anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "string" }],
    });
  });

  it("opens an enum inside a nullable union", () => {
    const open = openOutputJsonSchema({
      anyOf: [{ type: "string", enum: ["a"] }, { type: "null" }],
    });
    expect(open).toEqual({
      anyOf: [
        { anyOf: [{ type: "string", enum: ["a"] }, { type: "string" }] },
        { type: "null" },
      ],
    });
  });

  it("never touches const", () => {
    const union: JsonSchema = {
      oneOf: [
        {
          type: "object",
          properties: { ok: { type: "boolean", const: true } },
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { ok: { type: "boolean", const: false } },
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { status: { type: "string", const: "ready" } },
          additionalProperties: false,
        },
      ],
    };
    const open = openOutputJsonSchema(union);
    const members = open.oneOf as JsonSchema[];
    expect(members.map((m) => (m.properties as JsonSchema).ok ?? null)).toEqual(
      [
        { type: "boolean", const: true },
        { type: "boolean", const: false },
        null,
      ]
    );
    expect((members[2].properties as JsonSchema).status).toEqual({
      type: "string",
      const: "ready",
    });
  });

  it("leaves not and if alone, where opening would reject more", () => {
    const closed: JsonSchema = {
      type: "object",
      properties: { kind: { type: "string", enum: ["a"] } },
      additionalProperties: false,
    };
    const schema: JsonSchema = { not: closed, if: closed };
    expect(openOutputJsonSchema(schema)).toEqual(schema);
  });

  it("leaves enums that are not all strings alone", () => {
    const schema: JsonSchema = { type: "integer", enum: [1, 2] };
    expect(openOutputJsonSchema(schema)).toEqual(schema);
  });

  it("does not read a property named enum or additionalProperties as a keyword", () => {
    const schema: JsonSchema = {
      type: "object",
      properties: {
        enum: { type: "string" },
        additionalProperties: { type: "boolean" },
      },
      required: ["enum", "additionalProperties"],
    };
    expect(openOutputJsonSchema(schema)).toEqual(schema);
  });

  it("does not change its input, and opening twice changes nothing more", () => {
    const before = JSON.stringify(strict);
    const once = openOutputJsonSchema(strict);
    expect(JSON.stringify(strict)).toBe(before);
    expect(openOutputJsonSchema(once)).toEqual(once);
  });
});

describe("findBreakingChanges: output schemas", () => {
  it("flags a removed tool but not an added one", () => {
    expect(
      findBreakingChanges(
        catalog({ keep: {}, gone: {} }),
        catalog({ keep: {}, extra: {} })
      )
    ).toEqual(["gone: tool removed"]);
  });

  it("flags a removed required property, not a removed optional one", () => {
    const base = object({ id: STRING, note: STRING }, ["id"]);
    expect(outputBreaks(base, object({ note: STRING }, []))).toEqual([
      "t › output.id: required property removed",
    ]);
    expect(outputBreaks(base, object({ id: STRING }))).toEqual([]);
  });

  it("flags a required property that becomes optional, not the reverse", () => {
    const required = object({ id: STRING });
    const optional = object({ id: STRING }, []);
    expect(outputBreaks(required, optional)).toEqual([
      "t › output.id: required property is now optional",
    ]);
    expect(outputBreaks(optional, required)).toEqual([]);
  });

  it("ignores new properties, new required properties, and new enum values", () => {
    const base = object({
      id: STRING,
      kind: { type: "string", enum: ["a"] },
    });
    const head = object({
      id: STRING,
      kind: { type: "string", enum: ["a", "b"] },
      added: STRING,
    });
    expect(outputBreaks(base, head)).toEqual([]);
  });

  it("ignores removed enum values", () => {
    const two = object({ kind: { type: "string", enum: ["a", "b"] } });
    const one = object({ kind: { type: "string", enum: ["a"] } });
    expect(outputBreaks(two, one)).toEqual([]);
  });

  it("ignores a strict schema becoming open and the reverse", () => {
    const strict = {
      ...object({ kind: { type: "string", enum: ["a"] } }),
      additionalProperties: false,
    };
    const open = object(
      {
        kind: {
          anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "string" }],
        },
        added: STRING,
      },
      ["kind"]
    );
    expect(outputBreaks(strict, open)).toEqual([]);
    expect(outputBreaks(open, strict)).toEqual([]);
  });

  it("flags a property that can now be null, not the reverse", () => {
    expect(
      outputBreaks(object({ name: STRING }), object({ name: NULLABLE_STRING }))
    ).toEqual(["t › output.name: now also accepts null"]);
    expect(
      outputBreaks(object({ name: NULLABLE_STRING }), object({ name: STRING }))
    ).toEqual([]);
  });

  it("flags a type that grows, counting an integer as a number", () => {
    expect(
      outputBreaks(
        object({ n: { type: "integer" } }),
        object({ n: { type: "number" } })
      )
    ).toEqual(["t › output.n: now also accepts number"]);
    expect(
      outputBreaks(
        object({ n: { type: "number" } }),
        object({ n: { type: "integer" } })
      )
    ).toEqual([]);
    expect(
      outputBreaks(
        object({ v: STRING }),
        object({ v: { type: ["string", "number"] } })
      )
    ).toEqual(["t › output.v: now also accepts number"]);
  });

  it("flags a union that gains a member, not one that loses a member", () => {
    const member = (key: string) => object({ [key]: STRING });
    const two = { oneOf: [member("a"), member("b")] };
    const three = { oneOf: [member("a"), member("b"), member("c")] };
    expect(outputBreaks(two, three)).toEqual([
      "t › output: union gained a member",
    ]);
    expect(outputBreaks(three, two)).toEqual([]);
  });

  it("flags a nullable wrapper added around a union once", () => {
    const base = { anyOf: [{ type: "string" }, { type: "number" }] };
    const head = {
      anyOf: [{ type: "string" }, { type: "number" }, { type: "null" }],
    };
    expect(outputBreaks(object({ v: base }), object({ v: head }))).toEqual([
      "t › output.v: now also accepts null",
    ]);
  });

  it("compares union members by index when the counts match", () => {
    const base = {
      oneOf: [
        object({ status: { type: "string", const: "ready" }, url: STRING }),
        object({ status: { type: "string", const: "building" }, job: STRING }),
      ],
    };
    const head = {
      oneOf: [
        object({ status: { type: "string", const: "ready" } }),
        object({ status: { type: "string", const: "building" }, job: STRING }),
      ],
    };
    expect(outputBreaks(base, head)).toEqual([
      "t › output.oneOf[0].url: required property removed",
    ]);
  });

  it("flags a const that changes or is dropped, not one that is added", () => {
    const ready = object({ status: { type: "string", const: "ready" } });
    const done = object({ status: { type: "string", const: "done" } });
    const plain = object({ status: STRING });
    expect(outputBreaks(ready, done)).toEqual([
      't › output.status: const changed from "ready" to "done"',
    ]);
    expect(outputBreaks(ready, plain)).toEqual([
      't › output.status: const "ready" dropped',
    ]);
    expect(outputBreaks(plain, ready)).toEqual([]);
  });

  it("flags looser limits, not tighter ones", () => {
    const tight = object({
      name: { type: "string", maxLength: 10 },
      at: { type: "string", format: "date-time", pattern: "^\\d" },
      code: { type: "string", pattern: "^[A-Z]+$" },
    });
    const loose = object({
      name: { type: "string", maxLength: 20 },
      at: STRING,
      code: STRING,
    });
    expect(outputBreaks(tight, loose)).toEqual([
      "t › output.name: limits changed: maxLength 10 → 20",
      't › output.at: limits changed: format "date-time" → none',
      "t › output.code: limits changed: pattern removed",
    ]);
    expect(outputBreaks(loose, tight)).toEqual([]);
  });

  it("compares a schema with its nullable form inside the wrapper", () => {
    const owner = object({ id: STRING, name: STRING });
    const nullableOwner = {
      anyOf: [object({ id: STRING }), { type: "null" }],
    };
    expect(
      outputBreaks(object({ owner: nullableOwner }), object({ owner }))
    ).toEqual([]);
    expect(
      outputBreaks(
        object({ owner: { anyOf: [owner, { type: "null" }] } }),
        object({ owner: object({ id: STRING }) })
      )
    ).toEqual(["t › output.owner.name: required property removed"]);
    // Zod writes a nullable string either way, depending on its version.
    const listed = object({ v: { anyOf: [STRING, { type: "null" }] } });
    const typed = object({ v: NULLABLE_STRING });
    expect(outputBreaks(listed, typed)).toEqual([]);
    expect(outputBreaks(typed, listed)).toEqual([]);
  });

  it("finds a break inside arrays, records, and nested objects", () => {
    const row = (extra: Record<string, JsonSchema> = {}) =>
      object({ id: STRING, ...extra });
    const base = object({
      data: { type: "array", items: row({ owner: object({ name: STRING }) }) },
      byId: {
        type: "object",
        propertyNames: STRING,
        additionalProperties: object({ n: STRING }),
      },
    });
    const head = object({
      data: { type: "array", items: row({ owner: object({}) }) },
      byId: {
        type: "object",
        propertyNames: STRING,
        additionalProperties: object({}),
      },
    });
    expect(outputBreaks(base, head)).toEqual([
      "t › output.data[].owner.name: required property removed",
      "t › output.byId.*.n: required property removed",
    ]);
  });
});

describe("findBreakingChanges: input schemas", () => {
  it("flags a removed property at any depth, not an added optional one", () => {
    const base = object({ q: STRING, filter: object({ day: STRING }, []) }, []);
    expect(
      inputBreaks(base, object({ filter: object({ day: STRING }, []) }, []))
    ).toEqual(["t › input.q: property removed"]);
    expect(
      inputBreaks(base, object({ q: STRING, filter: object({}) }, []))
    ).toEqual(["t › input.filter.day: property removed"]);
    expect(
      inputBreaks(
        object({ q: STRING }, []),
        object({ q: STRING, page: { type: "integer" } }, [])
      )
    ).toEqual([]);
  });

  it("flags a property that becomes required and a new required property", () => {
    const optional = object({ q: STRING }, []);
    expect(inputBreaks(optional, object({ q: STRING }))).toEqual([
      "t › input.q: property is now required",
    ]);
    expect(
      inputBreaks(optional, object({ q: STRING, page: STRING }, ["page"]))
    ).toEqual(["t › input.page: new required property"]);
    expect(inputBreaks(object({ q: STRING }), optional)).toEqual([]);
  });

  it("flags a removed enum value, not an added one", () => {
    const two = object({ scope: { type: "string", enum: ["a", "b"] } });
    const three = object({ scope: { type: "string", enum: ["a", "b", "c"] } });
    const one = object({ scope: { type: "string", enum: ["a"] } });
    expect(inputBreaks(two, one)).toEqual([
      't › input.scope: enum value "b" removed',
    ]);
    expect(inputBreaks(two, three)).toEqual([]);
  });

  it("flags an enum value removed inside a nullable union", () => {
    const nullable = (values: string[]) =>
      object({
        scope: { anyOf: [{ type: "string", enum: values }, { type: "null" }] },
      });
    expect(inputBreaks(nullable(["a", "b"]), nullable(["a"]))).toEqual([
      't › input.scope.anyOf[0]: enum value "b" removed',
    ]);
  });

  it("flags an enum value removed while the value becomes nullable", () => {
    expect(
      inputBreaks(
        object({ scope: { type: "string", enum: ["a", "b"] } }),
        object({
          scope: { anyOf: [{ type: "string", enum: ["a"] }, { type: "null" }] },
        })
      )
    ).toEqual(['t › input.scope: enum value "b" removed']);
  });

  it("flags a plain value that becomes an enum", () => {
    expect(
      inputBreaks(
        object({ scope: STRING }),
        object({ scope: { type: "string", enum: ["a", "b"] } })
      )
    ).toEqual(['t › input.scope: now accepts only "a", "b"']);
  });

  it("flags tighter limits, not looser ones", () => {
    const loose = object({
      perPage: { type: "integer", minimum: 1, maximum: 100 },
      q: { type: "string", minLength: 1 },
      ids: { type: "array", items: STRING, maxItems: 100 },
      id: STRING,
      code: STRING,
    });
    const tight = object({
      perPage: { type: "integer", minimum: 1, maximum: 50 },
      q: { type: "string", minLength: 2, maxLength: 200 },
      ids: { type: "array", items: STRING, maxItems: 10 },
      id: { type: "string", format: "uuid", pattern: "^[0-9a-f-]+$" },
      code: { type: "string", pattern: "^[A-Z]+$" },
    });
    expect(inputBreaks(loose, tight)).toEqual([
      "t › input.perPage: limits changed: maximum 100 → 50",
      "t › input.q: limits changed: maxLength none → 200, minLength 1 → 2",
      "t › input.ids: limits changed: maxItems 100 → 10",
      't › input.id: limits changed: format none → "uuid"',
      "t › input.code: limits changed: pattern added",
    ]);
    expect(inputBreaks(tight, loose)).toEqual([]);
  });

  it("ignores Zod's safe-integer range and the pattern Zod pairs with a format", () => {
    const safe = {
      minimum: -Number.MAX_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    };
    expect(
      inputBreaks(
        object({ n: { type: "number" } }),
        object({ n: { type: "integer", ...safe } })
      )
    ).toEqual(["t › input.n: no longer accepts number"]);
    expect(
      inputBreaks(
        object({ id: { type: "string", format: "uuid", pattern: "^a$" } }),
        object({ id: { type: "string", format: "uuid", pattern: "^b$" } })
      )
    ).toEqual([]);
  });

  it("flags a const that changes", () => {
    expect(
      inputBreaks(
        object({ kind: { type: "string", const: "a" } }),
        object({ kind: { type: "string", const: "b" } })
      )
    ).toEqual(['t › input.kind: const changed from "a" to "b"']);
  });

  it("flags a type set that shrinks, not one that grows", () => {
    expect(
      inputBreaks(object({ q: NULLABLE_STRING }), object({ q: STRING }))
    ).toEqual(["t › input.q: no longer accepts null"]);
    expect(
      inputBreaks(object({ q: STRING }), object({ q: NULLABLE_STRING }))
    ).toEqual([]);
    expect(
      inputBreaks(
        object({ n: { type: "number" } }),
        object({ n: { type: "integer" } })
      )
    ).toEqual(["t › input.n: no longer accepts number"]);
    expect(
      inputBreaks(
        object({ n: { type: "integer" } }),
        object({ n: { type: "number" } })
      )
    ).toEqual([]);
  });

  it("flags a union that loses a member, not one that gains a member", () => {
    const two = { anyOf: [STRING, { type: "number" }] };
    const three = { anyOf: [STRING, { type: "number" }, { type: "boolean" }] };
    expect(inputBreaks(object({ v: three }), object({ v: two }))).toEqual([
      "t › input.v: no longer accepts boolean",
    ]);
    const objects = (count: number) => ({
      oneOf: Array.from({ length: count }, (_, i) =>
        object({ [`k${i}`]: STRING })
      ),
    });
    expect(inputBreaks(objects(3), objects(2))).toEqual([
      "t › input: union lost a member",
    ]);
    expect(inputBreaks(objects(2), objects(3))).toEqual([]);
  });

  it("does not read output rules for inputs", () => {
    // An output may gain a field; an input that loses a required one is fine.
    expect(
      inputBreaks(object({ q: STRING }), object({ q: STRING }, []))
    ).toEqual([]);
  });
});

describe("findBreakingChanges: the lab notebooks release", () => {
  it("flags what the lab notebooks release broke for older clients", () => {
    const findings = findBreakingChanges(
      beforeLabNotebooks,
      buildMcpCatalogDocument()
    );
    expect(findings).toEqual(
      expect.arrayContaining([
        "get_run › output.notebookLinks: required property removed",
        "search_runs › output.data[].notebook_links: required property removed",
        "global_search › output.runs[].matchedNotebookLink: required property removed",
        "search_runs › input.hasNotebookLink: property removed",
        "add_notebook_link: tool removed",
        "update_notebook_link: tool removed",
        "remove_notebook_link: tool removed",
      ])
    );
  });

  it("finds nothing when the catalog is compared with itself", () => {
    const current = buildMcpCatalogDocument();
    expect(findBreakingChanges(current, current)).toEqual([]);
  });

  it("finds nothing between the strict and the open form of the catalog", () => {
    const current = buildMcpCatalogDocument();
    // The closed form is what Zod emits before we open it.
    const strict: CatalogSchemas = {
      tools: MCP_TOOL_DEFS.map((def) => ({
        name: def.name,
        inputSchema: EMPTY_OBJECT,
        outputSchema: z.toJSONSchema(def.outputSchema, {
          target: "draft-2020-12",
          io: "output",
        }) as JsonSchema,
      })),
    };
    expect(JSON.stringify(strict)).toContain('"additionalProperties":false');
    const opened = {
      tools: current.tools.map((tool) => ({
        ...tool,
        inputSchema: EMPTY_OBJECT,
      })),
    };
    expect(findBreakingChanges(strict, opened)).toEqual([]);
    expect(findBreakingChanges(opened, strict)).toEqual([]);
  });
});
