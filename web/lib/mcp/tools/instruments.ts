import type { McpServer } from "@modelcontextprotocol/server";
import {
  getInstrumentById,
  getInstrumentListWithCounts,
} from "@/lib/api/instruments";
import { toolRegistrationConfig } from "@/lib/mcp/catalog/register";
import { resolveInstrumentFilterOptions } from "@/lib/mcp/instrument-filter-options";
import { errorResult, textResult } from "@/lib/mcp/tools/helpers";
import {
  getInstrumentFilterOptionsTool,
  getInstrumentTool,
  listInstrumentsTool,
} from "./instruments.defs";

export function registerInstrumentTools(server: McpServer) {
  server.registerTool(
    listInstrumentsTool.name,
    toolRegistrationConfig(listInstrumentsTool),
    async ({ status }) => {
      const instruments = await getInstrumentListWithCounts();
      const filtered = status
        ? instruments.filter((i) => i.status === status)
        : instruments;
      return textResult(filtered);
    }
  );

  server.registerTool(
    getInstrumentTool.name,
    toolRegistrationConfig(getInstrumentTool),
    async ({ instrumentId }) => {
      const instrument = await getInstrumentById(instrumentId);
      if (!instrument) {
        return errorResult(`Instrument '${instrumentId}' not found.`);
      }
      return textResult(instrument);
    }
  );

  server.registerTool(
    getInstrumentFilterOptionsTool.name,
    toolRegistrationConfig(getInstrumentFilterOptionsTool),
    async ({ instrumentId }) => {
      const result = await resolveInstrumentFilterOptions(instrumentId);
      if (!result.ok) {
        return errorResult(result.error);
      }
      return textResult({ instrumentId, options: result.options });
    }
  );
}
