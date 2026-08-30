export const RUN_REPORT_UI_RESOURCE_URI = "ui://data-hub/run-report";

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

export type McpUiToolVisibility = "model" | "app";

export interface McpUiToolMeta {
  resourceUri?: string;
  visibility?: readonly McpUiToolVisibility[];
}

export interface McpToolUiMeta {
  ui?: McpUiToolMeta;
  // Deprecated flat key. Hosts that still read `ui/resourceUri` need
  // this alongside the nested `ui.resourceUri` the spec prefers.
  "ui/resourceUri"?: string;
  // registerTool types `_meta` as a string index signature.
  [key: string]: unknown;
}

export function runReportToolUiMeta(
  visibility: readonly McpUiToolVisibility[]
): McpToolUiMeta {
  return {
    ui: {
      resourceUri: RUN_REPORT_UI_RESOURCE_URI,
      visibility,
    },
    "ui/resourceUri": RUN_REPORT_UI_RESOURCE_URI,
  };
}
