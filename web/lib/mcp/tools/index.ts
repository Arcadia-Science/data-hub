import type { McpServer } from "@modelcontextprotocol/server";
import { registerDiscoveryTools } from "@/lib/mcp/tools/discovery";
import { registerFileTools } from "@/lib/mcp/tools/files";
import { registerInstrumentTools } from "@/lib/mcp/tools/instruments";
import { registerReportViewTools } from "@/lib/mcp/tools/report-views";
import { registerRunTools } from "@/lib/mcp/tools/runs";
import { registerWatcherTools } from "@/lib/mcp/tools/watchers";

export function registerTools(server: McpServer) {
  registerInstrumentTools(server);
  registerRunTools(server);
  registerReportViewTools(server);
  registerDiscoveryTools(server);
  registerWatcherTools(server);
  registerFileTools(server);
}
