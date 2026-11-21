import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMock }));

import {
  deleteFilesAndOfferUndo,
  restoreFilesAndReport,
  UNDO_DELETE_MS,
} from "@/components/runs/file-action-flows";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const refresh = vi.fn();
const onFilesChanged = vi.fn();
const target = {
  instrumentId: "dishcam",
  runId: "run-1",
  onFilesChanged,
  refresh,
};

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deleteFilesAndOfferUndo", () => {
  it("says Deleted N files with an Undo that stays for ten seconds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          results: [
            { ok: true, id: 1, already_applied: false },
            { ok: true, id: 2, already_applied: false },
          ],
          linked: [
            { ok: true, id: 11, relation: "video", already_applied: false },
            { ok: true, id: 12, relation: "sidecar", already_applied: false },
            {
              ok: true,
              id: 13,
              relation: "preview_image",
              already_applied: false,
            },
          ],
        })
      )
    );

    await deleteFilesAndOfferUndo({
      ...target,
      batches: [[1, 2]],
      includeLinked: true,
    });

    expect(toastMock.success).toHaveBeenCalledTimes(1);
    const [text, options] = toastMock.success.mock.calls[0];
    expect(text).toBe("Deleted 5 files");
    expect(options.duration).toBe(UNDO_DELETE_MS);
    expect(options.duration).toBe(10_000);
    expect(options.action.label).toBe("Undo");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("restores exactly the files that the delete removed, with the linked switch off", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            // Someone else deleted this one first, so Undo leaves it alone.
            { ok: true, id: 1, already_applied: true },
            { ok: true, id: 2, already_applied: false },
          ],
          linked: [
            { ok: true, id: 11, relation: "video", already_applied: false },
          ],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { ok: true, id: 2, already_applied: false },
            { ok: true, id: 11, already_applied: false },
          ],
          linked: [],
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await deleteFilesAndOfferUndo({
      ...target,
      batches: [[1, 2]],
      includeLinked: true,
    });
    const { action } = toastMock.success.mock.calls[0][1];
    action.onClick();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe("/api/v1/instruments/dishcam/runs/run-1/files/restore");
    expect(JSON.parse(init.body)).toEqual({
      file_ids: [2, 11],
      include_linked: false,
    });
    await vi.waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Restored 2 files")
    );
  });

  it("counts the files that failed, and still offers Undo for the rest", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          results: [
            { ok: true, id: 1, already_applied: false },
            {
              ok: false,
              id: 2,
              status: 409,
              error: { code: "CONFLICT", message: "It is processing." },
            },
          ],
          linked: [],
        })
      )
    );

    await deleteFilesAndOfferUndo({
      ...target,
      batches: [[1, 2]],
      includeLinked: false,
    });

    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    const [text, options] = toastMock.warning.mock.calls[0];
    expect(text).toBe("Deleted 1 file, 1 failed");
    expect(options.description).toBe("It is processing.");
    expect(options.action.label).toBe("Undo");
  });

  it("says all failed, with no Undo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { code: "FORBIDDEN", message: "No access" } },
          403
        )
      )
    );

    await deleteFilesAndOfferUndo({
      ...target,
      batches: [[1, 2]],
      includeLinked: false,
    });

    expect(toastMock.error).toHaveBeenCalledWith("Failed to delete 2 files", {
      description: "No access",
    });
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("offers no Undo when nothing was deleted by this call", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          results: [{ ok: true, id: 1, already_applied: true }],
          linked: [],
        })
      )
    );

    await deleteFilesAndOfferUndo({
      ...target,
      batches: [[1]],
      includeLinked: false,
    });

    expect(toastMock.success.mock.calls[0][1].action).toBeUndefined();
  });
});

describe("telling the report that files changed", () => {
  it("says so after a delete, and after its Undo restores the files", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ ok: true, id: 1, already_applied: false }],
          linked: [],
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ ok: true, id: 1, already_applied: false }],
          linked: [],
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await deleteFilesAndOfferUndo({
      ...target,
      batches: [[1]],
      includeLinked: false,
    });
    expect(onFilesChanged).toHaveBeenCalledTimes(1);

    toastMock.success.mock.calls[0][1].action.onClick();
    await vi.waitFor(() => expect(onFilesChanged).toHaveBeenCalledTimes(2));
  });

  it("says nothing when the delete changed no file", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({}, 403))
        .mockResolvedValueOnce(
          jsonResponse({
            results: [{ ok: true, id: 1, already_applied: true }],
            linked: [],
          })
        )
    );

    await deleteFilesAndOfferUndo({
      ...target,
      batches: [[1]],
      includeLinked: false,
    });
    await deleteFilesAndOfferUndo({
      ...target,
      batches: [[1]],
      includeLinked: false,
    });

    expect(onFilesChanged).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("says so after a restore, and not after one that restored nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse({
            results: [{ ok: true, id: 1, already_applied: false }],
            linked: [],
          })
        )
        .mockResolvedValueOnce(jsonResponse({}, 500))
    );

    await restoreFilesAndReport({
      ...target,
      batches: [[1]],
      includeLinked: false,
    });
    expect(onFilesChanged).toHaveBeenCalledTimes(1);

    await restoreFilesAndReport({
      ...target,
      batches: [[1]],
      includeLinked: false,
    });
    expect(onFilesChanged).toHaveBeenCalledTimes(1);
  });
});

describe("restoreFilesAndReport", () => {
  it("says Restored N files and refreshes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          results: [{ ok: true, id: 1, already_applied: false }],
          linked: [
            { ok: true, id: 2, relation: "video", already_applied: false },
          ],
        })
      )
    );

    await restoreFilesAndReport({
      ...target,
      batches: [[1]],
      includeLinked: true,
    });

    expect(toastMock.success).toHaveBeenCalledWith("Restored 2 files");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("explains a file that could not come back", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          results: [
            { ok: true, id: 1, already_applied: false },
            {
              ok: false,
              id: 2,
              status: 409,
              error: {
                code: "CONFLICT",
                message: "Another file uses its path.",
              },
            },
          ],
          linked: [],
        })
      )
    );

    await restoreFilesAndReport({
      ...target,
      batches: [[1, 2]],
      includeLinked: false,
    });

    expect(toastMock.warning).toHaveBeenCalledWith(
      "Restored 1 file, 1 failed",
      {
        description: "Another file uses its path.",
      }
    );
  });
});
