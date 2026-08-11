import type { McpServer } from "@modelcontextprotocol/server";
import { getInstrumentSummaries, getUserById } from "@/lib/api/dashboard";
import { globalSearch } from "@/lib/api/search";
import { toolRegistrationConfig } from "@/lib/mcp/catalog/register";
import {
  errorResult,
  getMcpUserId,
  structuredResult,
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
    async ({ query, scope }) => {
      if (query.trim().length < MIN_QUERY_LENGTH) {
        return errorResult(
          `Query must be at least ${MIN_QUERY_LENGTH} characters.`
        );
      }
      const result = await globalSearch({
        query,
        scope: scope ?? "all",
      });
      return structuredResult(result);
    }
  );

  server.registerTool(
    getMeTool.name,
    toolRegistrationConfig(getMeTool),
    async (ctx) => {
      const authInfo = ctx.http?.authInfo;
      const userId = getMcpUserId(authInfo);
      if (!userId) {
        return errorResult("Authenticated user not available on this session.");
      }
      const user = await getUserById(userId);
      if (!user) {
        return errorResult(`User '${userId}' not found.`);
      }
      return structuredResult(user);
    }
  );

  server.registerTool(
    getSystemStatusTool.name,
    toolRegistrationConfig(getSystemStatusTool),
    // No inputSchema → v2 passes ServerContext as the only argument.
    async () => {
      const summaries = await getInstrumentSummaries();
      return structuredResult({ instruments: summaries });
    }
  );
}
