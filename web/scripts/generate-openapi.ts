// Optional local dump for inspection. Output is gitignored; production
// serves the schema from GET /api/v1/openapi.json (built statically).
import { writeFile } from "node:fs/promises";
import { buildOpenApiDocument } from "@/lib/api/openapi";

await writeFile(
  "openapi.json",
  `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`
);
