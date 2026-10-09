import { createOpenAPI } from "fumadocs-openapi/server";
import snapshot from "./openapi.snapshot.json";

// The API pages render from a committed snapshot of the OpenAPI document that
// `web/lib/api/openapi` builds. Regenerate it with `make docs-catalogs` (CI
// fails when the committed copy is out of date). Reading a local file means
// the docs build needs no network and always matches the code in the same
// commit.
//
// The library types its document as OpenAPI 3.2, while the app emits 3.1, so
// a plain JSON import does not type-check against it. The shapes the pages
// use are the same in both versions.
type OpenApiSchemaInput = Exclude<
  NonNullable<Parameters<typeof createOpenAPI>[0]>["input"],
  string[] | undefined
>[string];

export const openapi = createOpenAPI({
  input: {
    "data-hub": snapshot as unknown as OpenApiSchemaInput,
  },
});
