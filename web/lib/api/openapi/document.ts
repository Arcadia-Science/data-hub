import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";
import { registry } from "./registry";
import "./paths/meta";
import "./paths/instruments";
import "./paths/runs";
import "./paths/files";
import "./paths/watchers";
import "./paths/archive";

const DOCUMENT_TAGS = [
  { name: "Meta", description: "Schema discovery" },
  { name: "Instruments", description: "Instrument catalog" },
  {
    name: "Runs",
    description: "Instrument runs, comments, attributions, uploads, and search",
  },
  { name: "Files", description: "Run files, downloads, and reprocessing" },
  { name: "Watchers", description: "Watcher registration and telemetry" },
  { name: "Archive", description: "Run archive builds" },
] as const;

export function buildOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: "3.1.0",
    info: {
      title: "Data Hub API",
      version: "1.0.0",
      description:
        "Integrator REST API for Data Hub. Authenticate with a personal access token (`Authorization: Bearer dhub_…`). Session cookies also work for browser callers.",
    },
    servers: [
      { url: "/api/v1", description: "Relative to your Data Hub host" },
    ],
    security: [{ bearerAuth: [] }],
    tags: [...DOCUMENT_TAGS],
  });
}
