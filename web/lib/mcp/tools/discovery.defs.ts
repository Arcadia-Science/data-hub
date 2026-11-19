import { z } from "zod";
import type { McpToolDef } from "@/lib/mcp/catalog/types";
import {
  getMeOutputSchema,
  getSystemStatusOutputSchema,
  globalSearchOutputSchema,
} from "./discovery.output";

export const globalSearchTool = {
  name: "global_search",
  title: "Global Search",
  description:
    "Fuzzy search across runs, lab notebooks, files, instruments, users, and comments (same backend as the UI ⌘K palette). Prefer this over search_runs when the query may match a filename, instrument display name, attributor name, user, comment body, or a lab notebook's name or description. A pasted notebook link returns only that page's notebook, ignoring http vs. https, www., tracking parameters, the fragment, and a Notion page's title. Runs don't match through their notebooks: pass a notebook's id to search_runs notebookId for its runs, or to get_notebook. The users scope returns workspace member names/emails to any authenticated caller (no row-level member privacy). Use search_runs for date/status/metadata filters. Queries shorter than 2 characters are rejected.",
  group: "discovery",
  scope: "runs:read",
  inputSchema: {
    query: z.string().describe("Search query (min 2 characters)"),
    scope: z
      .enum([
        "all",
        "runs",
        "notebooks",
        "files",
        "instruments",
        "users",
        "comments",
      ])
      .optional()
      .describe("Limit results to one entity type (default: all)"),
  },
  outputSchema: globalSearchOutputSchema,
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const getMeTool = {
  name: "get_me",
  title: "Get Me",
  description:
    'Return the authenticated user\'s identity (id, name, email, image, isAdmin). Use the returned id with search_runs ranBy=, or pass ranBy="me" instead.',
  group: "discovery",
  outputSchema: getMeOutputSchema,
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const getSystemStatusTool = {
  name: "get_system_status",
  title: "Get System Status",
  description:
    "Get a dashboard-level overview: per-instrument run counts, whether new files can reach Data Hub (`connection`: online, restarting, connecting, or offline, with a reason when offline), pending upload counts, and how many runs need someone to act (upload failed, failed, or stalled).",
  group: "discovery",
  scope: "instruments:read",
  outputSchema: getSystemStatusOutputSchema,
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const DISCOVERY_TOOL_DEFS = [
  globalSearchTool,
  getMeTool,
  getSystemStatusTool,
] as const;
