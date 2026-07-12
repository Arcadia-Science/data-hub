import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getInstruments, getUserById } from "@/lib/api/dashboard";
import { getInstrumentFilterOptions } from "@/lib/api/instrument-runs";
import {
  getInstrumentById,
  getInstrumentListWithCounts,
} from "@/lib/api/instruments";
import type { InstrumentType } from "@/lib/db/schema";

// Instrument types that expose a structured filter-options resource. Must stay
// aligned with filters accepted by `search_runs` / `buildRunListQuery`.
const FILTERABLE_INSTRUMENT_TYPES = new Set<InstrumentType>([
  "plate_reader",
  "gel_doc",
  "qpcr",
  "hina_microscope",
  "epson_v700_scanner",
]);

function filterOptionsDescription(instrumentType: InstrumentType): string {
  switch (instrumentType) {
    case "plate_reader":
      return "Available wavelength, measurement mode, and measurement type values";
    case "gel_doc":
      return "Available capture type, imaging mode, wavelength, and color values";
    case "qpcr":
      return "Available dye channel values";
    case "hina_microscope":
      return "Available channel, dimension, and size values";
    case "epson_v700_scanner":
      return "Available DPI and color mode values";
    default:
      return "Available filter values";
  }
}

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
    "me",
    "datahub://me",
    {
      description:
        "Authenticated PAT owner's identity (id, name, email, image, isAdmin). Same payload as the get_me tool.",
      mimeType: "application/json",
    },
    async (_uri, extra) => {
      const userId = extra.authInfo?.extra?.userId as string | undefined;
      if (!userId) {
        return {
          contents: [
            {
              uri: "datahub://me",
              mimeType: "application/json",
              text: JSON.stringify(
                { error: "Authenticated user not available on this session." },
                null,
                2
              ),
            },
          ],
        };
      }

      const user = await getUserById(userId);
      if (!user) {
        return {
          contents: [
            {
              uri: "datahub://me",
              mimeType: "application/json",
              text: JSON.stringify(
                { error: `User '${userId}' not found.` },
                null,
                2
              ),
            },
          ],
        };
      }

      return {
        contents: [
          {
            uri: "datahub://me",
            mimeType: "application/json",
            text: JSON.stringify(user, null, 2),
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
              description: `${filterOptionsDescription(i.instrumentType)} for ${i.displayName}`,
              mimeType: "application/json",
            })),
          };
        },
      }
    ),
    {
      description:
        "Available filter values for an instrument. Values map directly to search_runs metadata filter arguments (wavelength/measurementMode/measurementType for plate readers; captureType/imagingMode/gelWavelength/gelColor for gel-doc; dyeChannel for qPCR; hinaChannel/hinaDimension/hinaSize for Hina; dpi/colorMode for Epson).",
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

      const result = await getInstrumentFilterOptions(
        instrument.instrumentType,
        instrumentId
      );

      const payload =
        result.kind === "default"
          ? {
              error: `Instrument type '${instrument.instrumentType}' has no structured filter options`,
            }
          : result.options;

      return {
        contents: [
          {
            uri: _uri.href,
            mimeType: "application/json",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    }
  );
}
