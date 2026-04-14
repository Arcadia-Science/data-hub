import { getInstruments } from "@/lib/api/dashboard";
import { getPlateReaderFilterOptions } from "@/lib/api/instrument-runs";
import { getInstrumentListWithCounts } from "@/lib/api/instruments";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerResources(server: McpServer) {
  server.registerResource(
    "instruments",
    "datahub://instruments",
    {
      description:
        "List of all instrument IDs, display names, and types. Use as reference context when constructing tool calls.",
      mimeType: "application/json",
    },
    async () => {
      const instruments = await getInstruments();
      return {
        contents: [
          {
            uri: "datahub://instruments",
            mimeType: "application/json",
            text: JSON.stringify(instruments, null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    "instrument-filter-options",
    new ResourceTemplate(
      "datahub://instruments/{instrumentId}/filter-options",
      {
        list: async () => {
          const instruments = await getInstrumentListWithCounts();
          const plateReaders = instruments.filter(
            (i) => i.instrumentType === "plate_reader"
          );
          return {
            resources: plateReaders.map((i) => ({
              uri: `datahub://instruments/${i.id}/filter-options`,
              name: `${i.displayName} filter options`,
              description: `Available wavelength, measurement mode, and measurement type values for ${i.displayName}`,
              mimeType: "application/json",
            })),
          };
        },
      }
    ),
    {
      description:
        "Available filter values (wavelengths, measurement modes, measurement types) for a plate reader instrument. Helps build valid search_runs queries.",
      mimeType: "application/json",
    },
    async (_uri, variables) => {
      const instrumentId = Array.isArray(variables.instrumentId)
        ? variables.instrumentId[0]
        : variables.instrumentId;
      if (!instrumentId) {
        return {
          contents: [
            {
              uri: _uri.href,
              mimeType: "application/json",
              text: JSON.stringify(
                { error: "instrumentId is required" },
                null,
                2
              ),
            },
          ],
        };
      }
      const options = await getPlateReaderFilterOptions(instrumentId);
      return {
        contents: [
          {
            uri: _uri.href,
            mimeType: "application/json",
            text: JSON.stringify(options, null, 2),
          },
        ],
      };
    }
  );
}
