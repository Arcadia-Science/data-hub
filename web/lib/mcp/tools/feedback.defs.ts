import { feedbackToolDefs } from "@arcadiascience/app-feedback-toolkit/mcp";
import { FEEDBACK_MCP_OPTIONS } from "@/lib/feedback-app";
import type { McpToolDef } from "@/lib/mcp/catalog/types";

// The feedback package owns these three tools. Data Hub builds the definitions
// here, from plain strings, so the public catalog needs no database.
export const FEEDBACK_TOOL_DEFS: readonly McpToolDef[] =
  feedbackToolDefs(FEEDBACK_MCP_OPTIONS).all;
