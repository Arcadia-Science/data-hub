import { z } from "zod";
import type { McpToolDef } from "@/lib/mcp/catalog/types";
import { searchChangelogOutputSchema } from "./changelog.output";

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

export const searchChangelogTool = {
  name: "search_changelog",
  title: "Search Changelog",
  description: `List or search Data Hub's changelog: what changed in the app, the API, the MCP server, and file processing, and when. Use it for "what changed this week", "what's new since October 1", "when did X change", and "is X fixed yet". Leave out \`query\` to list every entry in a date range, newest first; do not pass "what changed" as the query. With a \`query\`, the best match comes first. \`dateFrom\` and \`dateTo\` are calendar days with both ends included, matched on the day a change was released. A deployment lists an entry only once the change has reached it. Returns whole entries with a link to cite, up to \`limit\` (default ${DEFAULT_LIMIT}, at most ${MAX_LIMIT}); \`total\` says how many matched. Not for how-to questions about using Data Hub; use search_docs. Not for lab data.`,
  group: "docs",
  inputSchema: {
    query: z
      .string()
      .optional()
      .describe(
        "Topic words to look for, such as 'feedback Linear' or 'Hina image preview' (min 2 characters). Leave out to list entries by date alone."
      ),
    dateFrom: z
      .string()
      .optional()
      .describe("First day to include, as YYYY-MM-DD."),
    dateTo: z
      .string()
      .optional()
      .describe("Last day to include, as YYYY-MM-DD."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .optional()
      .describe(
        `Most entries to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`
      ),
  },
  outputSchema: searchChangelogOutputSchema,
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const CHANGELOG_TOOL_DEFS = [searchChangelogTool] as const;
