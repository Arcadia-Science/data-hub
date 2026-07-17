import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWatcherVersions } from "@/lib/pypi";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchWatcherVersions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns versions newest-first by upload time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          releases: {
            "0.1.0": [{ upload_time_iso_8601: "2024-01-01T00:00:00.000Z" }],
            "0.3.0": [{ upload_time_iso_8601: "2024-06-01T00:00:00.000Z" }],
            "0.2.0": [{ upload_time_iso_8601: "2024-03-01T00:00:00.000Z" }],
          },
        })
      )
    );

    await expect(fetchWatcherVersions()).resolves.toEqual({
      ok: true,
      versions: [
        { version: "0.3.0", uploadedAt: "2024-06-01T00:00:00.000Z" },
        { version: "0.2.0", uploadedAt: "2024-03-01T00:00:00.000Z" },
        { version: "0.1.0", uploadedAt: "2024-01-01T00:00:00.000Z" },
      ],
    });
  });

  it("drops fully-yanked releases and empty file lists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          releases: {
            "0.1.0": [{ upload_time_iso_8601: "2024-01-01T00:00:00.000Z" }],
            "0.2.0-yanked": [
              {
                upload_time_iso_8601: "2024-02-01T00:00:00.000Z",
                yanked: true,
              },
              {
                upload_time_iso_8601: "2024-02-02T00:00:00.000Z",
                yanked: true,
              },
            ],
            "0.3.0-empty": [],
            "0.4.0-partial": [
              {
                upload_time_iso_8601: "2024-04-01T00:00:00.000Z",
                yanked: true,
              },
              {
                upload_time_iso_8601: "2024-04-02T00:00:00.000Z",
                yanked: false,
              },
            ],
          },
        })
      )
    );

    await expect(fetchWatcherVersions()).resolves.toEqual({
      ok: true,
      versions: [
        { version: "0.4.0-partial", uploadedAt: "2024-04-02T00:00:00.000Z" },
        { version: "0.1.0", uploadedAt: "2024-01-01T00:00:00.000Z" },
      ],
    });
  });

  it("returns ok:false when PyPI responds non-OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ detail: "gone" }, 503))
    );

    await expect(fetchWatcherVersions()).resolves.toEqual({
      ok: false,
      versions: [],
    });
  });

  it("returns ok:false when the payload has no releases object", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ info: { name: "data-hub-watcher" } }))
    );

    await expect(fetchWatcherVersions()).resolves.toEqual({
      ok: false,
      versions: [],
    });
  });

  it("returns ok:false when fetch throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );

    await expect(fetchWatcherVersions()).resolves.toEqual({
      ok: false,
      versions: [],
    });
  });

  it("uses a five-minute Next.js revalidate window", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ releases: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchWatcherVersions();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://pypi.org/pypi/data-hub-watcher/json",
      expect.objectContaining({
        next: { revalidate: 300 },
        headers: { Accept: "application/json" },
      })
    );
  });
});
