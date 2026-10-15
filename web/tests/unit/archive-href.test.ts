import { describe, expect, it } from "vitest";
import { buildArchiveHref } from "@/lib/runs/archive-href";

const base = "/api/v1/instruments/gel-1/runs/run-1/download-archive";

describe("buildArchiveHref", () => {
  it("has no query for a whole-run download", () => {
    expect(buildArchiveHref("gel-1", "run-1")).toBe(base);
  });

  it("encodes run IDs that contain reserved characters", () => {
    expect(buildArchiveHref("gel-1", "run 1/a?b")).toBe(
      "/api/v1/instruments/gel-1/runs/run%201%2Fa%3Fb/download-archive"
    );
  });

  it("lists selected file IDs", () => {
    expect(buildArchiveHref("gel-1", "run-1", { fileIds: [4, 9, 12] })).toBe(
      `${base}?file_ids=4%2C9%2C12`
    );
  });

  it("passes the table's filters", () => {
    expect(
      buildArchiveHref("gel-1", "run-1", {
        search: " blot ",
        categories: ["raw", "processed"],
        statuses: ["failed"],
        dismissed: true,
      })
    ).toBe(
      `${base}?search=blot&category=raw%2Cprocessed&status=failed&dismissed=true`
    );
  });

  it("leaves out empty filters", () => {
    expect(
      buildArchiveHref("gel-1", "run-1", {
        search: "  ",
        categories: [],
        statuses: [],
        dismissed: false,
      })
    ).toBe(base);
  });

  it("uses only the file IDs when both are given", () => {
    expect(
      buildArchiveHref("gel-1", "run-1", { fileIds: [1], search: "x" })
    ).toBe(`${base}?file_ids=1`);
  });
});
