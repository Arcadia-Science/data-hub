// Optional local dump for inspection. Output is gitignored; production
// serves the schema from GET /mcp/v1/schema.json (built statically).
import { writeFile } from "node:fs/promises";
import { buildMcpCatalogDocument } from "@/lib/mcp/catalog";

await writeFile(
  "mcp-catalog.json",
  `${JSON.stringify(buildMcpCatalogDocument(), null, 2)}\n`
);
