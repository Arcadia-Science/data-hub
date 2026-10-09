// Writes the OpenAPI document the docs site renders its API pages from. The
// output is committed, and CI regenerates it and fails if the committed copy is
// out of date. Run `make docs-catalogs` (or `npm run openapi:generate` here)
// after changing anything under `lib/api/openapi/`. Production serves the same
// document from GET /api/v1/openapi.json (built statically).
import { writeFile } from "node:fs/promises";
import { buildOpenApiDocument } from "@/lib/api/openapi";

const OUTPUT_PATH = "../docs/site/src/lib/openapi.snapshot.json";

await writeFile(
  OUTPUT_PATH,
  `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`
);
