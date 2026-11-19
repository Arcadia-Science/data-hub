import { describe, expect, it } from "vitest";
// The MCP tool output schemas import `./schemas/common` directly, so when the
// server's first request is to `/mcp/v1`, these schemas are built before
// `registry.ts` calls `extendZodWithOpenApi`. Zod copies methods onto each
// schema when it's built, so these never get `.openapi()`. This file loads
// them in that order, the same as the server does then.
import { uploadFailureReasonSchema } from "@/lib/api/openapi/schemas/common";

describe("OpenAPI schemas loaded after ./schemas/common", () => {
  it("still load and build the document", async () => {
    // The order this test depends on: nothing has extended Zod yet.
    expect(uploadFailureReasonSchema).not.toHaveProperty("openapi");

    // A schema file that calls `.openapi()` on one of `./schemas/common`'s
    // exports throws here, and every route that loads it returns 500.
    const { buildOpenApiDocument } = await import("@/lib/api/openapi");

    expect(buildOpenApiDocument().paths).toHaveProperty(
      "/watchers/{watcherId}/upload-failures"
    );
  });
});
