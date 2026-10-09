// Writes the MCP catalog the docs site renders its tool, prompt, and resource
// pages from. The output is committed, and CI regenerates it and fails if the
// committed copy is out of date. Run `make docs-catalogs` (or
// `npm run mcp-catalog:generate` here) after changing MCP tools, prompts, or
// resources. Production serves the same document from GET /mcp/v1/schema.json
// (built statically).
import { writeFile } from "node:fs/promises";
import { buildMcpCatalogDocument } from "@/lib/mcp/catalog";

const OUTPUT_PATH = "../docs/site/src/lib/mcp-catalog.snapshot.json";

await writeFile(
  OUTPUT_PATH,
  `${JSON.stringify(buildMcpCatalogDocument(), null, 2)}\n`
);
