import type { McpToolDef } from "@/lib/mcp/catalog/types";
import { DISCOVERY_TOOL_DEFS } from "@/lib/mcp/tools/discovery.defs";
import { FILE_TOOL_DEFS } from "@/lib/mcp/tools/files.defs";
import { INSTRUMENT_TOOL_DEFS } from "@/lib/mcp/tools/instruments.defs";
import { RUN_TOOL_DEFS } from "@/lib/mcp/tools/runs.defs";
import { WATCHER_TOOL_DEFS } from "@/lib/mcp/tools/watchers.defs";

/** All tool catalog entries — order matches registration for stable docs. */
export const MCP_TOOL_DEFS: readonly McpToolDef[] = [
  ...INSTRUMENT_TOOL_DEFS,
  ...RUN_TOOL_DEFS,
  ...FILE_TOOL_DEFS,
  ...WATCHER_TOOL_DEFS,
  ...DISCOVERY_TOOL_DEFS,
];
