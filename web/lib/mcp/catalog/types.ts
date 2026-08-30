import type { ZodType } from "zod";
import type { McpToolUiMeta } from "@/lib/mcp/ui-apps";

export const MCP_TOOL_GROUPS = {
  instruments: "Instruments",
  runs: "Runs",
  attribution: "Run attribution",
  comments: "Comments",
  files: "Files",
  watchers: "Watchers",
  discovery: "Discovery",
} as const;

export type McpToolGroup = keyof typeof MCP_TOOL_GROUPS;

export interface McpToolAnnotations {
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  readOnlyHint?: boolean;
}

export interface McpToolDef {
  /** MCP Apps (SEP-1865) metadata. Hosts without Apps support ignore it. */
  _meta?: McpToolUiMeta;
  annotations?: McpToolAnnotations;
  description: string;
  group: McpToolGroup;
  inputSchema?: Record<string, ZodType>;
  name: string;
  /**
   * Full Zod schema for the tool's success payload (object or discriminated
   * union). Unlike `inputSchema`, this is not a field map. Prefer object
   * roots for list tools — bare arrays are re-wrapped as `{ result }` on
   * 2025-era MCP wire shapes.
   */
  outputSchema: ZodType;
  /**
   * REST-equivalent capability tag for the public catalog
   * (`GET /mcp/v1/schema.json`). MCP transport auth uses coarse OAuth
   * `read` / `write`; this field documents the finer-grained surface for
   * docs consumers and is not enforced at the tool handler.
   */
  scope?: string;
  title: string;
}

export interface McpPromptDef {
  argsSchema?: Record<string, ZodType>;
  description: string;
  name: string;
  title: string;
}

export type McpResourceDef = {
  name: string;
  description: string;
  mimeType?: string;
} & (
  | { kind: "static"; uri: string }
  | { kind: "template"; uriTemplate: string }
);

/** Shape served by `GET /mcp/v1/schema.json`. */
export interface McpCatalogDocument {
  info: {
    title: string;
    version: string;
    description: string;
    endpoint: string;
    transport: "streamable-http";
  };
  mcpCatalog: "1.0.0";
  prompts: Array<{
    name: string;
    title: string;
    description: string;
    argsSchema: Record<string, unknown>;
  }>;
  resources: Array<{
    name: string;
    description: string;
    mimeType?: string;
    uri?: string;
    uriTemplate?: string;
  }>;
  tools: Array<{
    name: string;
    title: string;
    description: string;
    group: McpToolGroup;
    scope?: string;
    annotations?: McpToolAnnotations;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
  }>;
}
