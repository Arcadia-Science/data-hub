import { zodRecordToJsonSchema } from "@/lib/mcp/catalog/json-schema";
import { MCP_TOOL_DEFS } from "@/lib/mcp/catalog/tools";
import type { McpCatalogDocument } from "@/lib/mcp/catalog/types";
import { MCP_PROMPT_DEFS } from "@/lib/mcp/prompts.defs";
import { MCP_RESOURCE_DEFS } from "@/lib/mcp/resources.defs";

export function buildMcpCatalogDocument(): McpCatalogDocument {
  return {
    mcpCatalog: "1.0.0",
    info: {
      title: "Data Hub MCP",
      version: "1.0.0",
      description:
        "Model Context Protocol server for Data Hub. Authenticate with a personal access token (`Authorization: Bearer dhub_…`). Tools enforce the same `<resource>:<action>` scopes as their REST counterparts.",
      endpoint: "/mcp/v1",
      transport: "streamable-http",
    },
    tools: MCP_TOOL_DEFS.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      group: tool.group,
      ...(tool.scope ? { scope: tool.scope } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      inputSchema: zodRecordToJsonSchema(tool.inputSchema),
    })),
    resources: MCP_RESOURCE_DEFS.map((resource) => ({
      name: resource.name,
      description: resource.description,
      ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
      ...(resource.kind === "static"
        ? { uri: resource.uri }
        : { uriTemplate: resource.uriTemplate }),
    })),
    prompts: MCP_PROMPT_DEFS.map((prompt) => ({
      name: prompt.name,
      title: prompt.title,
      description: prompt.description,
      argsSchema: zodRecordToJsonSchema(prompt.argsSchema),
    })),
  };
}
