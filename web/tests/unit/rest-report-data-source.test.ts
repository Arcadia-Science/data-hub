import { afterEach, describe, expect, it, vi } from "vitest";
import { createRestReportDataSource } from "@/lib/runs/rest-report-data-source";

describe("createRestReportDataSource", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds the existing report-items URL and download path", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ id: 1, filename: "a.png" }],
        pagination: { limit: 50, offset: 0, total: 1 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const source = createRestReportDataSource({
      instrumentId: "inst-1",
      runId: "run-1",
    });

    await source.fetchReportItems({
      kind: "image",
      offset: 0,
      limit: 50,
      search: "gel",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/instruments/inst-1/runs/run-1/report-items?kind=image&offset=0&limit=50&search=gel",
      { signal: undefined }
    );
    expect(source.resolveFileUrl(42)).toBe(
      "/api/v1/files/42/download?disposition=inline"
    );
    expect(source.peekFileUrl?.(42)).toBe(
      "/api/v1/files/42/download?disposition=inline"
    );
  });

  // Without this the seeker's debounced search leaves one full request per
  // keystroke running to completion.
  it("passes the caller's abort signal to fetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [],
        pagination: { limit: 50, offset: 0, total: 0 },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const source = createRestReportDataSource({
      instrumentId: "inst-1",
      runId: "run-1",
    });
    const controller = new AbortController();

    await source.fetchReportItems({
      kind: "image",
      offset: 0,
      limit: 50,
      signal: controller.signal,
    });

    expect(fetchMock.mock.calls[0][1]).toEqual({ signal: controller.signal });
  });

  it("parses a CSV once and caches every row", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "col_a,col_b\n1,2\n3,4\n5,6\n",
    });
    vi.stubGlobal("fetch", fetchMock);

    const source = createRestReportDataSource({
      instrumentId: "inst-1",
      runId: "run-1",
    });

    const first = await source.fetchTableRows(9);
    const second = await source.fetchTableRows(9);

    // Bytes come straight from S3 via the 302, and only once per file.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/files/9/download?disposition=inline"
    );
    expect(first).toEqual({
      columns: ["col_a", "col_b"],
      rows: [
        { col_a: "1", col_b: "2" },
        { col_a: "3", col_b: "4" },
        { col_a: "5", col_b: "6" },
      ],
    });
    expect(second).toBe(first);
  });

  it("reports an empty CSV as no columns and no rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, text: async () => "" })
    );

    const source = createRestReportDataSource({
      instrumentId: "inst-1",
      runId: "run-1",
    });

    expect(await source.fetchTableRows(9)).toEqual({ columns: [], rows: [] });
  });

  // The web app resolves artifacts on the server and passes them into the
  // page, so only the View implements the suffix lookup.
  it("does not implement resolveFileBySuffix", () => {
    const source = createRestReportDataSource({
      instrumentId: "inst-1",
      runId: "run-1",
    });
    expect(source.resolveFileBySuffix).toBeUndefined();
  });
});
