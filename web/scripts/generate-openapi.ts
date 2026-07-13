import { writeFile } from "node:fs/promises";
import { buildOpenApiDocument } from "@/lib/api/openapi";

await writeFile(
  "openapi.json",
  `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`
);
