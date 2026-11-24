import { registerFeedbackTools } from "@arcadiascience/app-feedback-toolkit/mcp";
import type { McpServer } from "@modelcontextprotocol/server";
import { feedback } from "@/lib/feedback";
import { withOpenOutputSchemas } from "@/lib/mcp/catalog/register";
import { registerChangelogTools } from "@/lib/mcp/tools/changelog";
import { registerDiscoveryTools } from "@/lib/mcp/tools/discovery";
import { registerDocsTools } from "@/lib/mcp/tools/docs";
import { registerFileTools } from "@/lib/mcp/tools/files";
import { registerInstrumentTools } from "@/lib/mcp/tools/instruments";
import { registerNotebookTools } from "@/lib/mcp/tools/notebooks";
import { registerReportViewTools } from "@/lib/mcp/tools/report-views";
import { registerRunTools } from "@/lib/mcp/tools/runs";
import { registerWatcherTools } from "@/lib/mcp/tools/watchers";

export function registerTools(server: McpServer) {
  registerInstrumentTools(server);
  registerRunTools(server);
  registerNotebookTools(server);
  registerReportViewTools(server);
  registerDiscoveryTools(server);
  registerDocsTools(server);
  registerChangelogTools(server);
  registerWatcherTools(server);
  registerFileTools(server);
  // The feedback package registers its tools itself, so open their output
  // schemas here. The other tools do it through `toolRegistrationConfig`.
  registerFeedbackTools(withOpenOutputSchemas(server), feedback);
}
