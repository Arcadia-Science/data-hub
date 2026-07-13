import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getInstrumentById,
  getInstrumentListWithCounts,
} from "@/lib/api/instruments";
import {
  errorResult,
  requireMcpScope,
  textResult,
} from "@/lib/mcp/tools/helpers";

export function registerInstrumentTools(server: McpServer) {
  server.registerTool(
    "list_instruments",
    {
      title: "List Instruments",
      description:
        "List all registered lab instruments with run counts, watcher status, and file patterns. Optionally filter by status.",
      inputSchema: {
        status: z
          .enum(["pending", "active", "inactive"])
          .optional()
          .describe("Filter instruments by status"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "instruments:read");
      if (scopeError) {
        return scopeError;
      }
      const instruments = await getInstrumentListWithCounts();
      const filtered = status
        ? instruments.filter((i) => i.status === status)
        : instruments;
      return textResult(filtered);
    }
  );

  server.registerTool(
    "get_instrument",
    {
      title: "Get Instrument",
      description:
        "Get detailed information about a specific instrument, including watcher online/offline counts and file patterns.",
      inputSchema: {
        instrumentId: z
          .string()
          .describe(
            "Kebab-case instrument identifier (e.g. 'spectramax-id3-plate-reader')"
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrumentId }, { authInfo }) => {
      const scopeError = requireMcpScope(authInfo, "instruments:read");
      if (scopeError) {
        return scopeError;
      }
      const instrument = await getInstrumentById(instrumentId);
      if (!instrument) {
        return errorResult(`Instrument '${instrumentId}' not found.`);
      }
      return textResult(instrument);
    }
  );
}
