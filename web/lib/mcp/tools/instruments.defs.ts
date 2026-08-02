import { z } from "zod";
import type { McpToolDef } from "@/lib/mcp/catalog/types";

export const listInstrumentsTool = {
  name: "list_instruments",
  title: "List Instruments",
  description:
    "List all registered lab instruments with run counts, watcher status, and file patterns. Optionally filter by status.",
  group: "instruments",
  inputSchema: {
    status: z
      .enum(["pending", "active", "inactive"])
      .optional()
      .describe("Filter instruments by status"),
  },
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const getInstrumentTool = {
  name: "get_instrument",
  title: "Get Instrument",
  description:
    "Get detailed information about a specific instrument, including watcher online/offline counts and file patterns.",
  group: "instruments",
  inputSchema: {
    instrumentId: z
      .string()
      .describe(
        "Kebab-case instrument identifier (e.g. 'spectramax-id3-plate-reader')"
      ),
  },
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const INSTRUMENT_TOOL_DEFS = [
  listInstrumentsTool,
  getInstrumentTool,
] as const;
