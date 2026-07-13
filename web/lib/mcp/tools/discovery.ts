import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getInstrumentSummaries, getUserById } from "@/lib/api/dashboard";
import { globalSearch } from "@/lib/api/search";
import {
  errorResult,
  getMcpUserId,
  requireMcpScope,
  textResult,
} from "@/lib/mcp/tools/helpers";
import { MIN_QUERY_LENGTH } from "@/lib/search-constants";

export function registerDiscoveryTools(server: McpServer) {
  server.registerTool(
    "global_search",
    {
      title: "Global Search",
      description:
        "Fuzzy search across runs, files, and instruments (same backend as the UI ⌘K palette). Prefer this over search_runs when the query may match a filename, instrument display name, or attributor name. Use search_runs for date/status/metadata filters. Queries shorter than 2 characters are rejected.",
      inputSchema: {
        query: z.string().describe("Search query (min 2 characters)"),
        scope: z
          .enum(["all", "runs", "files", "instruments"])
          .optional()
          .describe("Limit results to one entity type (default: all)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, scope }, { authInfo }) => {
      // Intentionally gated on runs:read alone, mirroring the REST palette
      // endpoint (`GET /api/v1/search`). A runs:read-only token can therefore
      // see filenames here; that's the existing product contract for search,
      // not an MCP-specific broadening.
      const scopeError = requireMcpScope(authInfo, "runs:read");
      if (scopeError) {
        return scopeError;
      }
      if (query.trim().length < MIN_QUERY_LENGTH) {
        return errorResult(
          `Query must be at least ${MIN_QUERY_LENGTH} characters.`
        );
      }
      const result = await globalSearch({
        query,
        scope: scope ?? "all",
      });
      return textResult(result);
    }
  );

  server.registerTool(
    "get_me",
    {
      title: "Get Me",
      description:
        'Return the authenticated PAT owner\'s identity (id, name, email, image, isAdmin). Use the returned id with search_runs ranBy=, or pass ranBy="me" instead.',
      annotations: { readOnlyHint: true },
    },
    async ({ authInfo }) => {
      const userId = getMcpUserId(authInfo);
      if (!userId) {
        return errorResult("Authenticated user not available on this session.");
      }
      const user = await getUserById(userId);
      if (!user) {
        return errorResult(`User '${userId}' not found.`);
      }
      return textResult(user);
    }
  );

  server.registerTool(
    "get_system_status",
    {
      title: "Get System Status",
      description:
        "Get a dashboard-level overview: per-instrument run counts, watcher health (online/offline/no_watcher), and pending upload counts.",
      annotations: { readOnlyHint: true },
    },
    // No inputSchema → the SDK passes the request `extra` as a single
    // argument; pull `authInfo` directly off it.
    async ({ authInfo }) => {
      // Dashboard summary keyed per-instrument; gated on `instruments:read`
      // for parity with the dashboard data source. Watcher health is
      // included for context but isn't the primary axis.
      const scopeError = requireMcpScope(authInfo, "instruments:read");
      if (scopeError) {
        return scopeError;
      }
      const summaries = await getInstrumentSummaries();
      return textResult(summaries);
    }
  );
}
