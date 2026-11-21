import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteRunFiles,
  fetchLinkedFiles,
  fileBatches,
  inBatches,
  linkedFilesFromResponse,
  restoreRunFiles,
  tallyDeleteResponse,
  tallyRestoreResponse,
} from "@/lib/runs/run-file-requests";

afterEach(() => {
  vi.unstubAllGlobals();
});

// What the delete route answers for two requested files and the files that went
// along with them.
const deleteBody = {
  results: [
    { ok: true, id: 1, already_applied: false },
    { ok: true, id: 2, already_applied: false },
  ],
  linked: [
    { ok: true, id: 11, relation: "video", already_applied: false },
    { ok: true, id: 12, relation: "preview_image", already_applied: false },
  ],
};

describe("inBatches", () => {
  it("cuts a list into batches of at most 100, in order", () => {
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    const batches = inBatches(ids);
    expect(batches.map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(batches.flat()).toEqual(ids);
  });

  it("makes no batch for an empty list", () => {
    expect(inBatches([])).toEqual([]);
  });
});

describe("fileBatches", () => {
  // `count` raw files in `folder`, numbered from `from`.
  function folderOf(folder: string, count: number, from: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: from + i,
      filename: `f${from + i}.tif`,
      relativePath: `${folder}/f${from + i}.tif`,
    }));
  }

  it("keeps a folder's files in one batch, so its run.json can go along", () => {
    // 60 + 60 files would split the second folder at 100 if cut by count.
    const a = folderOf("plate/a", 60, 1);
    const b = folderOf("plate/b", 60, 101);
    const batches = fileBatches([...a, ...b]);
    expect(batches).toEqual([a.map((f) => f.id), b.map((f) => f.id)]);
  });

  it("groups by folder even when the selection interleaves them", () => {
    const [a1, a2] = folderOf("x", 2, 1);
    const [b1] = folderOf("y", 1, 10);
    expect(fileBatches([a1, b1, a2], 2)).toEqual([[1, 2], [10]]);
  });

  it("packs small folders together up to the limit", () => {
    const files = [
      ...folderOf("a", 30, 1),
      ...folderOf("b", 30, 101),
      ...folderOf("c", 30, 201),
    ];
    expect(fileBatches(files).map((batch) => batch.length)).toEqual([90]);
  });

  it("splits a folder that holds more than one batch", () => {
    const big = folderOf("big", 150, 1);
    const small = folderOf("small", 10, 1001);
    expect(
      fileBatches([...small, ...big]).map((batch) => batch.length)
    ).toEqual([10, 100, 50]);
  });

  it("reads a file with no stored path as being in the watch folder", () => {
    expect(
      fileBatches(
        [
          { id: 1, filename: "a.mp4", relativePath: null },
          { id: 2, filename: "dir/b.tif", relativePath: "dir/b.tif" },
          { id: 3, filename: "c.jpg", relativePath: null },
        ],
        2
      )
    ).toEqual([[1, 3], [2]]);
  });
});

describe("tallyDeleteResponse", () => {
  it("counts the requested and the linked files, and lists all as removed", () => {
    expect(tallyDeleteResponse(deleteBody)).toEqual({
      done: 4,
      failed: 0,
      message: null,
      removedIds: [1, 2, 11, 12],
    });
  });

  it("counts a file that was already deleted as done, but leaves it out of Undo", () => {
    const tally = tallyDeleteResponse({
      results: [
        { ok: true, id: 1, already_applied: true },
        { ok: true, id: 2, already_applied: false },
      ],
      linked: [],
    });
    expect(tally.done).toBe(2);
    expect(tally.removedIds).toEqual([2]);
  });

  it("counts a refusal as failed and keeps the first reason", () => {
    const tally = tallyDeleteResponse({
      results: [
        {
          ok: false,
          id: 1,
          status: 409,
          error: {
            code: "CONFLICT",
            message: "Wait for processing to finish.",
          },
        },
        {
          ok: false,
          id: 3,
          status: 404,
          error: { code: "NOT_FOUND", message: "File '3' not found" },
        },
        { ok: true, id: 2, already_applied: false },
      ],
      linked: [],
    });
    expect(tally).toEqual({
      done: 1,
      failed: 2,
      message: "Wait for processing to finish.",
      removedIds: [2],
    });
  });

  it("reads an unreadable answer as nothing done", () => {
    expect(tallyDeleteResponse(null)).toEqual({
      done: 0,
      failed: 0,
      message: null,
      removedIds: [],
    });
  });
});

describe("tallyRestoreResponse", () => {
  it("counts a refused linked file as failed too", () => {
    const tally = tallyRestoreResponse({
      results: [{ ok: true, id: 1, already_applied: false }],
      linked: [
        { ok: true, id: 2, relation: "video", already_applied: false },
        {
          ok: false,
          id: 3,
          relation: "sidecar",
          status: 409,
          error: { code: "CONFLICT", message: "Another file uses its path." },
        },
      ],
    });
    expect(tally).toEqual({
      done: 2,
      failed: 1,
      message: "Another file uses its path.",
    });
  });
});

describe("linkedFilesFromResponse", () => {
  it("lists each linked file once, even when two files share it", () => {
    const sidecar = {
      id: 9,
      filename: "run.json",
      size_bytes: 2048,
      category: "raw",
      relation: "sidecar",
      deleted_at: null,
    };
    const files = linkedFilesFromResponse({
      groups: [
        {
          file_id: 1,
          linked: [
            {
              id: 5,
              filename: "a.mp4",
              size_bytes: null,
              category: "processed",
              relation: "video",
              deleted_at: null,
            },
            sidecar,
          ],
        },
        { file_id: 2, linked: [sidecar] },
      ],
    });
    expect(files).toEqual([
      { id: 5, filename: "a.mp4", relation: "video", sizeBytes: null },
      { id: 9, filename: "run.json", relation: "sidecar", sizeBytes: 2048 },
    ]);
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("deleteRunFiles", () => {
  it("sends one request a batch", async () => {
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const { file_ids } = JSON.parse(String(init?.body));
      return Promise.resolve(
        jsonResponse({
          results: file_ids.map((id: number) => ({
            ok: true,
            id,
            already_applied: false,
          })),
          linked: [],
        })
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const ids = Array.from({ length: 230 }, (_, i) => i + 1);

    const tally = await deleteRunFiles(
      "dishcam",
      "run 1",
      inBatches(ids),
      true
    );

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/v1/instruments/dishcam/runs/run%201/files/delete");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body)).include_linked).toBe(true);
    expect(
      fetchMock.mock.calls.map(
        ([, call]) => JSON.parse(String(call?.body)).file_ids.length
      )
    ).toEqual([100, 100, 30]);
    expect(tally.done).toBe(230);
    expect(tally.removedIds).toEqual(ids);
  });

  it("counts a whole batch as failed when its request fails, and carries on", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: "FORBIDDEN", message: "No access" } },
          403
        )
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ ok: true, id: 101, already_applied: false }],
          linked: [],
        })
      );
    vi.stubGlobal("fetch", fetchMock);
    const ids = Array.from({ length: 101 }, (_, i) => i + 1);

    const tally = await deleteRunFiles("dishcam", "r", inBatches(ids), false);

    expect(tally).toEqual({
      done: 1,
      failed: 100,
      message: "No access",
      removedIds: [101],
    });
  });

  it("counts a network error as failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const tally = await deleteRunFiles("dishcam", "r", [[1, 2]], false);
    expect(tally.failed).toBe(2);
    expect(tally.done).toBe(0);
  });
});

describe("restoreRunFiles", () => {
  it("posts to the restore endpoint with the linked switch as given", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        results: [{ ok: true, id: 1, already_applied: false }],
        linked: [],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const tally = await restoreRunFiles("dishcam", "r", [[1]], false);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("/api/v1/instruments/dishcam/runs/r/files/restore");
    expect(JSON.parse(String(init.body))).toEqual({
      file_ids: [1],
      include_linked: false,
    });
    expect(tally.done).toBe(1);
  });
});

describe("fetchLinkedFiles", () => {
  it("asks for the delete mode in batches and merges the answers", async () => {
    const fetchMock = vi.fn((url: string) => {
      const ids = new URL(url, "http://x").searchParams
        .get("file_ids")
        ?.split(",");
      return Promise.resolve(
        jsonResponse({
          groups: [
            {
              file_id: Number(ids?.[0]),
              linked: [
                {
                  id: 9,
                  filename: "run.json",
                  size_bytes: 1,
                  category: "raw",
                  relation: "sidecar",
                  deleted_at: null,
                },
              ],
            },
          ],
        })
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const ids = Array.from({ length: 150 }, (_, i) => i + 1);

    const linked = await fetchLinkedFiles(
      "dishcam",
      "r",
      inBatches(ids),
      "delete"
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("&for=delete");
    expect(linked?.map((file) => file.id)).toEqual([9]);
  });

  it("returns null when a lookup fails, so a dialog can say it could not check", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({}, 500))
    );
    expect(await fetchLinkedFiles("dishcam", "r", [[1]], "restore")).toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    expect(await fetchLinkedFiles("dishcam", "r", [[1]], "restore")).toBeNull();
  });
});
