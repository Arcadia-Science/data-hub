import type { McpResourceDef } from "@/lib/mcp/catalog/types";

export const instrumentsResource = {
  name: "instruments",
  description:
    "List of all instrument IDs, display names, and types. Use as reference context when constructing tool calls.",
  mimeType: "application/json",
  kind: "static",
  uri: "datahub://instruments",
} as const satisfies McpResourceDef;

export const meResource = {
  name: "me",
  description:
    "Authenticated user's identity (id, name, email, image, isAdmin). Same payload as the get_me tool.",
  mimeType: "application/json",
  kind: "static",
  uri: "datahub://me",
} as const satisfies McpResourceDef;

export const glossaryResource = {
  name: "glossary",
  description:
    "Static reference: run status derivation, instrument types, ranBy literals, UTC date semantics, and archive polling.",
  mimeType: "application/json",
  kind: "static",
  uri: "datahub://glossary",
} as const satisfies McpResourceDef;

export const instrumentFilterOptionsResource = {
  name: "instrument-filter-options",
  description:
    "Available filter values for an instrument. Values map directly to search_runs metadata filter arguments (wavelength/measurementMode/measurementType for plate readers; captureType/imagingMode/gelWavelength/gelColor for gel-doc; dyeChannel for qPCR; hinaChannel/hinaDimension/hinaSize for Hina; dpi/colorMode for Epson).",
  mimeType: "application/json",
  kind: "template",
  uriTemplate: "datahub://instruments/{instrumentId}/filter-options",
} as const satisfies McpResourceDef;

export const MCP_RESOURCE_DEFS = [
  instrumentsResource,
  meResource,
  glossaryResource,
  instrumentFilterOptionsResource,
] as const;
