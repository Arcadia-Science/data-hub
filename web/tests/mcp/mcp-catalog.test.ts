import { describe, expect, it } from "vitest";
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
    expect(MCP_TOOL_DEFS).toHaveLength(32);
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
});
