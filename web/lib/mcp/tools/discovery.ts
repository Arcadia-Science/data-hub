import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getInstrumentSummaries, getUserById } from "@/lib/api/dashboard";
import { globalSearch } from "@/lib/api/search";
import { toolRegistrationConfig } from "@/lib/mcp/catalog/register";
import {
  errorResult,
  getMcpUserId,
  requireMcpScope,
  textResult,
} from "@/lib/mcp/tools/helpers";
import { MIN_QUERY_LENGTH } from "@/lib/search-constants";
import {
  getMeTool,
  getSystemStatusTool,
  globalSearchTool,
} from "./discovery.defs";

export function registerDiscoveryTools(server: McpServer) {
  server.registerTool(
    globalSearchTool.name,
    toolRegistrationConfig(globalSearchTool),
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
    getMeTool.name,
    toolRegistrationConfig(getMeTool),
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
    getSystemStatusTool.name,
    toolRegistrationConfig(getSystemStatusTool),
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
