import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "@/lib/api/openapi";

describe("OpenAPI document", () => {
  it("generates the documented API", () => {
    const document = buildOpenApiDocument();

    expect(document.openapi).toBe("3.1.0");
    expect(document.paths).toHaveProperty("/instruments");
    expect(document.paths).toHaveProperty("/openapi.json");
    expect(document.components?.securitySchemes).toHaveProperty("bearerAuth");
    expect(document.tags?.map((tag) => tag.name)).toEqual(
      expect.arrayContaining([
        "Meta",
        "Instruments",
        "Runs",
        "Files",
        "Watchers",
        "Archive",
      ])
    );
  });
});
