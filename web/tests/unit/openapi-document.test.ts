import { describe, expect, it } from "vitest";
import {
  buildOpenApiDocument,
  createInstrumentBody,
  createRunBody,
  requestUploadBody,
  watcherEventBody,
} from "@/lib/api/openapi";

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

  it("documents restore and archive download with the route scopes", () => {
    const document = buildOpenApiDocument();
    const restore =
      document.paths?.["/instruments/{instrumentId}/runs/{runId}/restore"]
        ?.post;
    const archive =
      document.paths?.[
        "/instruments/{instrumentId}/runs/{runId}/download-archive"
      ]?.get;

    expect(restore?.description).toContain("`runs:delete`");
    expect(archive?.description).toContain("`files:read`");
  });

  it("documents report items with the route scope and offset paging", () => {
    const document = buildOpenApiDocument();
    const reportItems =
      document.paths?.["/instruments/{instrumentId}/runs/{runId}/report-items"]
        ?.get;
    const queryParams = (reportItems?.parameters ?? []).filter(
      (param) => "in" in param && param.in === "query"
    );

    expect(reportItems?.description).toContain("`files:read`");
    expect(
      queryParams.map((param) => ("name" in param ? param.name : null))
    ).toEqual(expect.arrayContaining(["kind", "search", "offset", "limit"]));
  });

  it("marks numeric path params as required integers", () => {
    const document = buildOpenApiDocument();
    const params = document.paths?.["/files/{fileId}"]?.patch?.parameters ?? [];
    const fileId = params.find(
      (param) => "name" in param && param.name === "fileId"
    );

    expect(fileId).toMatchObject({
      in: "path",
      required: true,
      schema: { type: "integer" },
    });
  });
});

describe("request body schemas", () => {
  it("trims run_id and rejects blank values", () => {
    expect(
      createRunBody.parse({ run_id: "  abc  ", source: "lambda" }).run_id
    ).toBe("abc");
    expect(
      createRunBody.safeParse({ run_id: "   ", source: "lambda" }).success
    ).toBe(false);
  });

  it("trims display_name so whitespace falls back in the route", () => {
    expect(
      createInstrumentBody.parse({ id: "my-instrument", display_name: "  " })
        .display_name
    ).toBe("");
  });

  it("requires at least one file_id for upload requests", () => {
    expect(requestUploadBody.safeParse({ file_ids: [] }).success).toBe(false);
    expect(requestUploadBody.parse({ file_ids: [1] }).file_ids).toEqual([1]);
  });

  it("rejects event types that only Data Hub writes when a watcher posts events", () => {
    const event = (event_type: string) => ({
      events: [{ event_type, timestamp: "2026-01-01T00:00:00Z", message: "x" }],
    });

    expect(
      watcherEventBody.safeParse(event("upload_requests_cancelled")).success
    ).toBe(false);
    expect(watcherEventBody.safeParse(event("error")).success).toBe(true);
  });

  it("documents server-only event types when reading events, but not when posting them", () => {
    const eventsPath =
      buildOpenApiDocument().paths?.["/watchers/{watcherId}/events"];
    const postSchema = JSON.stringify(eventsPath?.post?.requestBody ?? {});
    const listSchema = JSON.stringify(
      eventsPath?.get?.responses?.["200"] ?? {}
    );

    expect(postSchema).not.toContain("upload_requests_cancelled");
    expect(listSchema).toContain("upload_requests_cancelled");
  });
});
