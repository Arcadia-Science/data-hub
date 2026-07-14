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
