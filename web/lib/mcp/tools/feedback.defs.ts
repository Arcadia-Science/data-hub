import { feedbackToolDefs } from "@arcadia-science/app-feedback/mcp";
import { FEEDBACK_APP } from "@/lib/feedback-app";
import type { McpToolDef } from "@/lib/mcp/catalog/types";

// The feedback package owns these three tools. Data Hub builds the definitions
// here, from plain strings, so the public catalog needs no database.
export const FEEDBACK_TOOL_DEFS: readonly McpToolDef[] = feedbackToolDefs({
  appName: FEEDBACK_APP.appName,
  appScope: FEEDBACK_APP.mcpAppScope,
  guidance: FEEDBACK_APP.mcpGuidance,
}).all;
