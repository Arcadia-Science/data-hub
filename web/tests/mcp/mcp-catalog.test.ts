import { describe, expect, it } from "vitest";
import { z } from "zod";
import { instrumentStatusSchema } from "@/lib/api/openapi/schemas/common";
import {
  buildMcpCatalogDocument,
  MCP_PROMPT_DEFS,
  MCP_RESOURCE_DEFS,
  MCP_TOOL_DEFS,
} from "@/lib/mcp/catalog";

describe("MCP catalog document", () => {
  it("includes every catalog tool, prompt, and resource by name", () => {
    const doc = buildMcpCatalogDocument();

    expect(doc.tools.map((t) => t.name).sort()).toEqual(
      [...MCP_TOOL_DEFS.map((t) => t.name)].sort()
    );
    expect(doc.prompts.map((p) => p.name).sort()).toEqual(
      [...MCP_PROMPT_DEFS.map((p) => p.name)].sort()
    );
    expect(doc.resources.map((r) => r.name).sort()).toEqual(
      [...MCP_RESOURCE_DEFS.map((r) => r.name)].sort()
    );
  });

  it("emits JSON Schema objects for every tool and prompt", () => {
    const doc = buildMcpCatalogDocument();
    for (const tool of doc.tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
    for (const prompt of doc.prompts) {
      expect(prompt.argsSchema).toMatchObject({ type: "object" });
    }
  });

  it("publishes outputSchema for every tool", () => {
    const doc = buildMcpCatalogDocument();
    expect(MCP_TOOL_DEFS).toHaveLength(52);
    for (const def of MCP_TOOL_DEFS) {
      expect(def.outputSchema, `${def.name} missing outputSchema`).toBeTruthy();
      const tool = doc.tools.find((t) => t.name === def.name);
      if (!tool) {
        throw new Error(`${def.name} missing from catalog`);
      }
      // Object roots expose `type`; discriminated unions may be `oneOf`/`anyOf`.
      expect(
        tool.outputSchema.type != null ||
          tool.outputSchema.oneOf != null ||
          tool.outputSchema.anyOf != null,
        `${def.name} catalog outputSchema missing type/oneOf/anyOf`
      ).toBe(true);
    }
  });

  it("stamps type:object on discriminated-union output schemas", () => {
    const doc = buildMcpCatalogDocument();
    const archive = doc.tools.find((t) => t.name === "get_run_archive");
    if (!archive) {
      throw new Error("get_run_archive missing from catalog");
    }
    expect(archive.outputSchema.type).toBe("object");
    expect(
      archive.outputSchema.oneOf != null || archive.outputSchema.anyOf != null
    ).toBe(true);
  });

  it("preserves per-tool scope tags on the public catalog payload", () => {
    const doc = buildMcpCatalogDocument();
    const scopedDefs = MCP_TOOL_DEFS.filter((t) => t.scope);
    expect(scopedDefs.length).toBeGreaterThan(0);
    for (const def of scopedDefs) {
      const tool = doc.tools.find((t) => t.name === def.name);
      expect(tool?.scope).toBe(def.scope);
    }
  });

  it("documents static URIs and templates distinctly", () => {
    const doc = buildMcpCatalogDocument();
    const staticResources = doc.resources.filter((r) => r.uri);
    const templates = doc.resources.filter((r) => r.uriTemplate);
    expect(staticResources.length).toBeGreaterThan(0);
    expect(templates.length).toBeGreaterThan(0);
    for (const resource of doc.resources) {
      expect(Boolean(resource.uri) !== Boolean(resource.uriTemplate)).toBe(
        true
      );
    }
  });

  it("publishes open output schemas", () => {
    const doc = buildMcpCatalogDocument();
    for (const tool of doc.tools) {
      expect(
        findClosedNodes(tool.outputSchema),
        `${tool.name} output schema is closed`
      ).toEqual([]);
    }
  });

  it("lists the known enum values and allows any other string", () => {
    const doc = buildMcpCatalogDocument();
    const list = doc.tools.find((t) => t.name === "list_instruments");
    const instruments = (
      list?.outputSchema.properties as Record<string, SchemaNode>
    ).instruments.items as SchemaNode;
    const status = (instruments.properties as Record<string, SchemaNode>)
      .status;
    expect(status).toEqual({
      anyOf: [
        { type: "string", enum: instrumentStatusSchema.options },
        { type: "string" },
      ],
    });
  });

  it("keeps every const in the output schemas", () => {
    const doc = buildMcpCatalogDocument();
    for (const def of MCP_TOOL_DEFS) {
      const tool = doc.tools.find((t) => t.name === def.name);
      const zodJson = z.toJSONSchema(def.outputSchema, {
        target: "draft-2020-12",
        io: "output",
      });
      expect(consts(tool?.outputSchema), `${def.name} const values`).toEqual(
        consts(zodJson)
      );
    }
    const archive = doc.tools.find((t) => t.name === "get_run_archive");
    expect(consts(archive?.outputSchema)).toEqual(
      expect.arrayContaining(["ready", "building"])
    );
  });

  it("keeps input schemas closed", () => {
    const doc = buildMcpCatalogDocument();
    for (const tool of doc.tools) {
      expect(
        tool.inputSchema.additionalProperties,
        `${tool.name} input schema`
      ).toBe(false);
    }
  });
});

type SchemaNode = Record<string, unknown>;

function isStringEnum(node: SchemaNode): boolean {
  return (
    Array.isArray(node.enum) && node.enum.every((v) => typeof v === "string")
  );
}

/** A string enum listed next to a plain string: the known values or any other. */
function isOpenEnum(node: SchemaNode): boolean {
  const members = node.anyOf;
  return (
    Array.isArray(members) &&
    members.length === 2 &&
    isStringEnum(members[0]) &&
    JSON.stringify(members[1]) === '{"type":"string"}'
  );
}

/** Every closed object and every string enum that has no plain string beside it. */
function findClosedNodes(schema: unknown, path = "output"): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) =>
      findClosedNodes(item, `${path}[${index}]`)
    );
  }
  if (typeof schema !== "object" || schema === null) {
    return [];
  }
  const node = schema as SchemaNode;
  if (isOpenEnum(node)) {
    return [];
  }
  const closed: string[] = [];
  if (node.additionalProperties === false) {
    closed.push(`${path}: additionalProperties is false`);
  }
  if (isStringEnum(node)) {
    closed.push(`${path}: closed enum`);
  }
  for (const [key, value] of Object.entries(node)) {
    closed.push(...findClosedNodes(value, `${path}.${key}`));
  }
  return closed;
}

function consts(schema: unknown): unknown[] {
  if (Array.isArray(schema)) {
    return schema.flatMap(consts);
  }
  if (typeof schema !== "object" || schema === null) {
    return [];
  }
  const node = schema as SchemaNode;
  return [
    ...("const" in node ? [node.const] : []),
    ...Object.values(node).flatMap(consts),
  ];
}
