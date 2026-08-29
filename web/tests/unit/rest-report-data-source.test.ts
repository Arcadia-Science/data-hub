import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchAllTableRows } from "@/lib/runs/report-table";
import { createRestReportDataSource } from "@/lib/runs/rest-report-data-source";
import type { ReportDataSource } from "@/lib/runs/view-data-source";

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
      "/api/v1/instruments/inst-1/runs/run-1/report-items?kind=image&offset=0&limit=50&search=gel"
    );
    expect(source.resolveFileUrl(42)).toBe("/api/v1/files/42/download");
    expect(source.peekFileUrl?.(42)).toBe("/api/v1/files/42/download");
  });

  it("parses a CSV once, then serves paginated slices from cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "col_a,col_b\n1,2\n3,4\n5,6\n",
    });
    vi.stubGlobal("fetch", fetchMock);

    const source = createRestReportDataSource({
      instrumentId: "inst-1",
      runId: "run-1",
    });

    const first = await source.fetchTable({ fileId: 9, offset: 0, limit: 2 });
    const second = await source.fetchTable({ fileId: 9, offset: 2, limit: 2 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/files/9/download");
    expect(first).toEqual({
      columns: ["col_a", "col_b"],
      rows: [
        { col_a: "1", col_b: "2" },
        { col_a: "3", col_b: "4" },
      ],
      total: 3,
    });
    expect(second.rows).toEqual([{ col_a: "5", col_b: "6" }]);
    expect(second.total).toBe(3);
  });

  it("rejects fetchArtifact because no browser REST route exists", async () => {
    const source = createRestReportDataSource({
      instrumentId: "inst-1",
      runId: "run-1",
    });
    await expect(
      source.fetchArtifact({ suffix: "_aunty_plate.json" })
    ).rejects.toThrow(/not available over REST/);
  });
});

describe("fetchAllTableRows", () => {
  it("walks paginated fetchTable until every row is collected", async () => {
    const pages = [
      {
        columns: ["n"],
        rows: [{ n: "1" }, { n: "2" }],
        total: 3,
      },
      {
        columns: ["n"],
        rows: [{ n: "3" }],
        total: 3,
      },
    ];
    const dataSource: Pick<ReportDataSource, "fetchTable"> = {
      fetchTable: vi.fn(({ offset }) =>
        Promise.resolve(pages[offset === 0 ? 0 : 1])
      ),
    };

    const result = await fetchAllTableRows(
      dataSource as ReportDataSource,
      7,
      2
    );

    expect(result.rows.map((r) => r.n)).toEqual(["1", "2", "3"]);
    expect(result.truncated).toBe(false);
    expect(dataSource.fetchTable).toHaveBeenCalledTimes(2);
  });

  it("marks the table truncated when paging stops short of total", async () => {
    const dataSource: Pick<ReportDataSource, "fetchTable"> = {
      fetchTable: vi.fn(({ offset }) =>
        Promise.resolve({
          columns: ["n"],
          rows: offset === 0 ? [{ n: "1" }] : [],
          total: 5,
          truncated: true,
        })
      ),
    };

    const result = await fetchAllTableRows(
      dataSource as ReportDataSource,
      7,
      1
    );

    expect(result.rows).toEqual([{ n: "1" }]);
    expect(result.truncated).toBe(true);
  });
});
