import snapshot from "./mcp-catalog.snapshot.json";

export interface McpCatalogTool {
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
  description: string;
  group: string;
  inputSchema: Record<string, unknown>;
  name: string;
  outputSchema?: Record<string, unknown>;
  title: string;
}

export interface McpCatalogResource {
  description: string;
  mimeType?: string;
  name: string;
  uri?: string;
  uriTemplate?: string;
}

export interface McpCatalogPrompt {
  argsSchema: Record<string, unknown>;
  description: string;
  name: string;
  title: string;
}

export interface McpCatalogDocument {
  info: {
    title: string;
    version: string;
    description: string;
    endpoint: string;
    transport: string;
  };
  mcpCatalog: string;
  prompts: McpCatalogPrompt[];
  resources: McpCatalogResource[];
  tools: McpCatalogTool[];
}

const GROUP_LABELS: Record<string, string> = {
  instruments: "Instruments",
  runs: "Runs",
  attribution: "Run attribution",
  comments: "Comments",
  files: "Files",
  watchers: "Watchers",
  discovery: "Discovery",
};

export function groupLabel(group: string): string {
  return GROUP_LABELS[group] ?? group;
}

/**
 * The catalog `web/lib/mcp/catalog` builds, committed as a snapshot. Regenerate
 * it with `make docs-catalogs`; CI fails when the committed copy is out of
 * date. Reading it locally means the docs build needs no network and always
 * matches the code in the same commit.
 */
export function getMcpCatalog(): McpCatalogDocument {
  return snapshot as McpCatalogDocument;
}
