import { z } from "zod";
import type { McpToolDef } from "@/lib/mcp/catalog/types";

export const globalSearchTool = {
  name: "global_search",
  title: "Global Search",
  description:
    "Fuzzy search across runs, files, instruments, users, and comments (same backend as the UI ⌘K palette). Prefer this over search_runs when the query may match a filename, instrument display name, attributor name, user, or comment body. The users scope returns workspace member names/emails to any caller with runs:read (no row-level member privacy). Use search_runs for date/status/metadata filters. Queries shorter than 2 characters are rejected.",
  group: "discovery",
  scope: "runs:read",
  inputSchema: {
    query: z.string().describe("Search query (min 2 characters)"),
    scope: z
      .enum(["all", "runs", "files", "instruments", "users", "comments"])
      .optional()
      .describe("Limit results to one entity type (default: all)"),
  },
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const getMeTool = {
  name: "get_me",
  title: "Get Me",
  description:
    'Return the authenticated PAT owner\'s identity (id, name, email, image, isAdmin). Use the returned id with search_runs ranBy=, or pass ranBy="me" instead.',
  group: "discovery",
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const getSystemStatusTool = {
  name: "get_system_status",
  title: "Get System Status",
  description:
    "Get a dashboard-level overview: per-instrument run counts, watcher health (online/offline/no_watcher), and pending upload counts.",
  group: "discovery",
  scope: "instruments:read",
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const DISCOVERY_TOOL_DEFS = [
  globalSearchTool,
  getMeTool,
  getSystemStatusTool,
] as const;
