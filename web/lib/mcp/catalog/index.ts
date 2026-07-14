// Public boundary for the MCP catalog document and defs used by registration.
// biome-ignore lint/performance/noBarrelFile: Package entry for schema route + registrars.
export { buildMcpCatalogDocument } from "@/lib/mcp/catalog/document";
export {
  promptRegistrationConfig,
  toolRegistrationConfig,
} from "@/lib/mcp/catalog/register";
export { MCP_TOOL_DEFS } from "@/lib/mcp/catalog/tools";
export {
  MCP_TOOL_GROUPS,
  type McpCatalogDocument,
  type McpPromptDef,
  type McpResourceDef,
  type McpToolDef,
  type McpToolGroup,
} from "@/lib/mcp/catalog/types";
export { MCP_PROMPT_DEFS } from "@/lib/mcp/prompts.defs";
export { MCP_RESOURCE_DEFS } from "@/lib/mcp/resources.defs";
