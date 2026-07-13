import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDiscoveryTools } from "@/lib/mcp/tools/discovery";
import { registerFileTools } from "@/lib/mcp/tools/files";
import { registerInstrumentTools } from "@/lib/mcp/tools/instruments";
import { registerRunTools } from "@/lib/mcp/tools/runs";
import { registerWatcherTools } from "@/lib/mcp/tools/watchers";

export function registerTools(server: McpServer) {
  registerInstrumentTools(server);
  registerRunTools(server);
  registerDiscoveryTools(server);
  registerWatcherTools(server);
  registerFileTools(server);
}
