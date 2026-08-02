import { type McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { getInstruments, getUserById } from "@/lib/api/dashboard";
import { getInstrumentFilterOptions } from "@/lib/api/instrument-runs";
import {
  getInstrumentById,
  getInstrumentListWithCounts,
} from "@/lib/api/instruments";
import type { InstrumentType } from "@/lib/db/schema";
import { DATAHUB_GLOSSARY } from "@/lib/mcp/glossary";
import { getMcpUserId } from "@/lib/mcp/tools/helpers";
import {
  glossaryResource,
  instrumentFilterOptionsResource,
  instrumentsResource,
  meResource,
} from "./resources.defs";

// Instrument types with structured filter-options. Must match `search_runs` args.
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
    instrumentsResource.name,
    instrumentsResource.uri,
    {
      description: instrumentsResource.description,
      mimeType: instrumentsResource.mimeType,
    },
    async () => {
      const instruments = await getInstruments();
      return {
        contents: [
          {
            uri: instrumentsResource.uri,
            mimeType: instrumentsResource.mimeType,
            text: JSON.stringify(instruments, null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    meResource.name,
    meResource.uri,
    {
      description: meResource.description,
      mimeType: meResource.mimeType,
    },
    async (_uri, ctx) => {
      const userId = getMcpUserId(ctx.http?.authInfo);
      if (!userId) {
        return {
          contents: [
            {
              uri: meResource.uri,
              mimeType: meResource.mimeType,
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
              uri: meResource.uri,
              mimeType: meResource.mimeType,
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
            uri: meResource.uri,
            mimeType: meResource.mimeType,
            text: JSON.stringify(user, null, 2),
          },
        ],
      };
    }
  );

  server.registerResource(
    glossaryResource.name,
    glossaryResource.uri,
    {
      description: glossaryResource.description,
      mimeType: glossaryResource.mimeType,
    },
    async () => ({
      contents: [
        {
          uri: glossaryResource.uri,
          mimeType: glossaryResource.mimeType,
          text: JSON.stringify(DATAHUB_GLOSSARY, null, 2),
        },
      ],
    })
  );

  server.registerResource(
    instrumentFilterOptionsResource.name,
    new ResourceTemplate(instrumentFilterOptionsResource.uriTemplate, {
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
    }),
    {
      description: instrumentFilterOptionsResource.description,
      mimeType: instrumentFilterOptionsResource.mimeType,
    },
    async (_uri, variables, _ctx) => {
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
