import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getInstruments } from "@/lib/api/dashboard";
import {
  getGelDocFilterOptions,
  getPlateReaderFilterOptions,
} from "@/lib/api/instrument-runs";
import {
  getInstrumentById,
  getInstrumentListWithCounts,
} from "@/lib/api/instruments";

// Instrument types that expose a structured filter-options resource. Generic
// instruments have no predefined metadata schema so they're excluded.
const FILTERABLE_INSTRUMENT_TYPES = new Set(["plate_reader", "gel_doc"]);

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
          const filterable = instruments.filter((i) =>
            FILTERABLE_INSTRUMENT_TYPES.has(i.instrumentType)
          );
          return {
            resources: filterable.map((i) => ({
              uri: `datahub://instruments/${i.id}/filter-options`,
              name: `${i.displayName} filter options`,
              description:
                i.instrumentType === "plate_reader"
                  ? `Available wavelength, measurement mode, and measurement type values for ${i.displayName}`
                  : `Available capture type, imaging mode, wavelength, and color values for ${i.displayName}`,
              mimeType: "application/json",
            })),
          };
        },
      }
    ),
    {
      description:
        "Available filter values for an instrument. Plate readers expose wavelengths and measurement modes/types; gel-doc instruments expose capture types, imaging modes, wavelengths, and colors. Helps build valid search_runs queries.",
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

      // Resolve the instrument type so we can call the correct options
      // function. Unknown or unfilterable types return an explanatory error.
      const instrument = await getInstrumentById(instrumentId);
      if (!instrument) {
        return {
          contents: [
            {
              uri: _uri.href,
              mimeType: "application/json",
              text: JSON.stringify(
                { error: `Instrument '${instrumentId}' not found` },
                null,
                2
              ),
            },
          ],
        };
      }

      let options: unknown;
      if (instrument.instrumentType === "plate_reader") {
        options = await getPlateReaderFilterOptions(instrumentId);
      } else if (instrument.instrumentType === "gel_doc") {
        options = await getGelDocFilterOptions(instrumentId);
      } else {
        options = {
          error: `Instrument type '${instrument.instrumentType}' has no structured filter options`,
        };
      }

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
