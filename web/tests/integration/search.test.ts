import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchResponse } from "@/lib/api/openapi";
import { type GlobalSearchResult, globalSearch } from "@/lib/api/search";
import {
  files,
  instrumentRuns,
  instruments,
  notebooks,
  personalAccessTokens,
  runComments,
  runNotebookLinks,
  watchers,
} from "@/lib/db/schema";
import { notebookUrlKey } from "@/lib/notebook-links/url";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// Seeds a run with the given files and returns the run's UUID.
async function seedRun(
  instrumentId: string,
  runId: string,
  filenames: string[]
): Promise<string> {
  const db = getTestDb();
  const [run] = await db
    .insert(instrumentRuns)
    .values({ instrumentId, runId })
    .returning({ id: instrumentRuns.id });
  if (filenames.length > 0) {
    await db.insert(files).values(
      filenames.map((filename, i) => ({
        instrumentRunId: run.id,
        filename,
        relativePath: filename,
        sizeBytes: (i + 1) * 1000,
      }))
    );
  }
  return run.id;
}

// Synthetic Notion page IDs: 32 hex digits, the last two from `n`.
function notionId(n: number): string {
  return `7c1d2e3f4a5b4c6d8e9f0a1b2c3d4e${n.toString(16).padStart(2, "0")}`;
}

// Seeds a notebook holding the given runs and returns its ID.
async function seedNotebook({
  url,
  name,
  description = null,
  runIds = [],
  deleted = false,
}: {
  url: string;
  name: string;
  description?: string | null;
  runIds?: string[];
  deleted?: boolean;
}): Promise<string> {
  const db = getTestDb();
  const urlKey = notebookUrlKey(url);
  if (!urlKey) {
    throw new Error(`Not a notebook link: ${url}`);
  }
  const [notebook] = await db
    .insert(notebooks)
    .values({
      url,
      urlKey,
      name,
      description,
      deletedAt: deleted ? new Date() : null,
    })
    .returning({ id: notebooks.id });
  if (runIds.length > 0) {
    await db
      .insert(runNotebookLinks)
      .values(runIds.map((runId) => ({ runId, notebookId: notebook.id })));
  }
  return notebook.id;
}

// Seeds runs with no files, acquired at the given times, and returns their
// UUIDs in the same order.
async function seedRunsAcquiredAt(
  instrumentId: string,
  runs: { runId: string; acquiredAt: string; deleted?: boolean }[]
): Promise<string[]> {
  const rows = await getTestDb()
    .insert(instrumentRuns)
    .values(
      runs.map((run) => ({
        instrumentId,
        runId: run.runId,
        acquiredAt: new Date(run.acquiredAt),
        deletedAt: run.deleted ? new Date() : null,
      }))
    )
    .returning({ id: instrumentRuns.id, runId: instrumentRuns.runId });
  const ids = new Map(rows.map((row) => [row.runId, row.id]));
  return runs.map((run) => ids.get(run.runId) ?? "");
}

async function search(
  token: string,
  query: string,
  scope?: string
): Promise<GlobalSearchResult> {
  const params = new URLSearchParams({ q: query });
  if (scope) {
    params.set("scope", scope);
  }
  const res = await api(`/api/v1/search?${params}`, { token });
  expect(res.status).toBe(200);
  const body = await res.json();
  // The documented response shape still describes what the route returns.
  searchResponse.parse(body);
  return body as GlobalSearchResult;
}

describe("Global search API", () => {
  let token: string;
  let authorUserId: string;
  let botTokenId: string;
  let specialRunUuid: string;

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());
    ({ userId: authorUserId } = await seedTestUser({
      name: "Dakota Lab",
      email: "dakota.search@example.com",
    }));
    ({ tokenId: botTokenId } = await seedTestUser({ tokenName: "qc-bot" }));

    const db = getTestDb();
    await db.insert(instruments).values([
      {
        id: "hina-microscope",
        displayName: "Hina Microscope",
        status: "active",
      },
      { id: "plate-reader-x", displayName: "Plate Reader X", status: "active" },
    ]);

    // The Hina microscope watches for *.nd2; Plate Reader X watches for *.csv
    // but has no runs (exercises the zero-run pattern-match case).
    await db.insert(watchers).values([
      {
        instrumentId: "hina-microscope",
        hostname: "hina-pc",
        status: "watching",
        lastHeartbeatAt: new Date(),
        configYaml: 'instrument:\n  file_patterns:\n    - "*.nd2"\n',
      },
      {
        instrumentId: "plate-reader-x",
        hostname: "plate-pc",
        status: "watching",
        lastHeartbeatAt: new Date(),
        configYaml: 'instrument:\n  file_patterns:\n    - "*.csv"\n',
      },
    ]);

    await seedRun("hina-microscope", "20260706_112803_385", ["sample_012.nd2"]);
    await seedRun("hina-microscope", "20260630_101502_204", ["scan_009.nd2"]);
    // Literal special characters: `photo.*jpg` must match a `.*jpg` query while
    // `photoXjpg` must not (the query is never treated as a regex/glob).
    specialRunUuid = await seedRun("hina-microscope", "special-run", [
      "photo.*jpg",
      "photoXjpg",
    ]);

    await db.insert(runComments).values([
      {
        runId: specialRunUuid,
        userId: authorUserId,
        body: "Growth curve looks promising after UBE2A rescue",
      },
      {
        runId: specialRunUuid,
        userId: authorUserId,
        body: "Soft-deleted note about UBE2A should not match",
        deletedAt: new Date(),
      },
      {
        runId: specialRunUuid,
        userId: authorUserId,
        // Match sits past the preview window; markdown should be stripped and
        // the snippet should recenter on the hit rather than the head.
        body: `${"**pad** ".repeat(40)}late marker ZYZZYVA-TOKEN in **bold**`,
      },
      {
        // Written by a token, so there is no user to join to.
        runId: specialRunUuid,
        tokenId: botTokenId,
        body: "Automated check flagged an OUTLIER-QZX reading",
      },
    ]);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("requires authentication", async () => {
    const res = await api("/api/v1/search?q=nd2");
    expect(res.status).toBe(401);
  });

  it("returns an empty result below the minimum query length", async () => {
    const result = await search(token, "n");
    expect(result.counts.total).toBe(0);
    expect(result.runs).toHaveLength(0);
    expect(result.notebooks).toHaveLength(0);
    expect(result.files).toHaveLength(0);
    expect(result.instruments).toHaveLength(0);
    expect(result.users).toHaveLength(0);
    expect(result.comments).toHaveLength(0);
  });

  it("matches a run by its run id", async () => {
    const result = await search(token, "20260706");
    const run = result.runs.find((r) => r.runId === "20260706_112803_385");
    expect(run).toBeDefined();
    expect(run?.matchReason).toBe("run_id");
    expect(run?.matchedFilename).toBeNull();
  });

  it("surfaces runs, files, and the instrument together for a nested filename match", async () => {
    const result = await search(token, "nd2");

    // Both nd2-bearing runs surface, attributed to the contained file.
    const runIds = result.runs.map((r) => r.runId);
    expect(runIds).toContain("20260706_112803_385");
    expect(runIds).toContain("20260630_101502_204");
    const run = result.runs.find((r) => r.runId === "20260706_112803_385");
    expect(run?.matchReason).toBe("file");
    expect(run?.matchedFilename).toBe("sample_012.nd2");

    // The individual files surface in the Files group.
    const filenames = result.files.map((f) => f.filename);
    expect(filenames).toContain("sample_012.nd2");
    expect(filenames).toContain("scan_009.nd2");

    // The instrument surfaces via its configured *.nd2 pattern.
    const instrument = result.instruments.find(
      (i) => i.id === "hina-microscope"
    );
    expect(instrument).toBeDefined();
    expect(instrument?.matchReason).toBe("pattern");
    expect(instrument?.matchedPattern).toBe("*.nd2");
  });

  it("matches an instrument by display name", async () => {
    const result = await search(token, "Hina");
    const instrument = result.instruments.find(
      (i) => i.id === "hina-microscope"
    );
    expect(instrument).toBeDefined();
    expect(instrument?.matchReason).toBe("name");
  });

  it("returns an instrument's connection, which its badge reads", async () => {
    const result = await search(token, "Hina", "instruments");
    const instrument = result.instruments.find(
      (i) => i.id === "hina-microscope"
    );
    expect(instrument?.status).toBe("active");
    expect(instrument?.connection).toEqual({ state: "online", reason: null });
  });

  it("scopes results to a single type when requested", async () => {
    const result = await search(token, "nd2", "runs");
    expect(result.runs.length).toBeGreaterThan(0);
    expect(result.notebooks).toHaveLength(0);
    expect(result.files).toHaveLength(0);
    expect(result.instruments).toHaveLength(0);
    expect(result.users).toHaveLength(0);
    expect(result.comments).toHaveLength(0);
  });

  it("treats special characters in the query literally, not as a pattern", async () => {
    const result = await search(token, ".*jpg", "files");
    const filenames = result.files.map((f) => f.filename);
    expect(filenames).toContain("photo.*jpg");
    expect(filenames).not.toContain("photoXjpg");
  });

  it("returns a pattern-matched instrument even when it has zero runs", async () => {
    const result = await search(token, "csv", "instruments");
    const instrument = result.instruments.find(
      (i) => i.id === "plate-reader-x"
    );
    expect(instrument).toBeDefined();
    expect(instrument?.matchReason).toBe("pattern");
    expect(instrument?.runCount).toBe(0);
  });

  it("matches users by name and email", async () => {
    const byName = await search(token, "Dakota", "users");
    expect(byName.users).toHaveLength(1);
    expect(byName.users[0]?.name).toBe("Dakota Lab");
    expect(byName.users[0]?.email).toBe("dakota.search@example.com");
    expect(byName.runs).toHaveLength(0);
    expect(byName.comments).toHaveLength(0);

    const byEmail = await search(token, "dakota.search", "users");
    expect(byEmail.users).toHaveLength(1);
    expect(byEmail.users[0]?.id).toBe(authorUserId);
  });

  it("matches comments by body and excludes soft-deleted comments", async () => {
    const result = await search(token, "UBE2A", "comments");
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.bodyPreview).toContain("Growth curve");
    expect(result.comments[0]?.runId).toBe("special-run");
    expect(result.comments[0]?.instrumentId).toBe("hina-microscope");
    expect(result.comments[0]?.userId).toBe(authorUserId);
    expect(result.users).toHaveLength(0);
  });

  it("finds a comment written by a token and names the token", async () => {
    const result = await search(token, "OUTLIER-QZX", "comments");
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]).toMatchObject({
      runId: "special-run",
      instrumentId: "hina-microscope",
      userId: null,
      userName: null,
      token: { id: botTokenId, name: "qc-bot", revoked: false },
    });
  });

  it("keeps finding a token comment after the token is revoked", async () => {
    const db = getTestDb();
    await db
      .update(personalAccessTokens)
      .set({ revokedAt: new Date() })
      .where(eq(personalAccessTokens.id, botTokenId));
    try {
      const result = await globalSearch({
        query: "OUTLIER-QZX",
        scope: "comments",
      });
      expect(result.comments).toHaveLength(1);
      expect(result.comments[0]?.token).toEqual({
        id: botTokenId,
        name: "qc-bot",
        revoked: true,
      });
      expect(result.comments[0]?.userId).toBeNull();
    } finally {
      await db
        .update(personalAccessTokens)
        .set({ revokedAt: null })
        .where(eq(personalAccessTokens.id, botTokenId));
    }
  });

  it("windows comment previews around the match and strips markdown", async () => {
    const result = await search(token, "ZYZZYVA-TOKEN", "comments");
    expect(result.comments).toHaveLength(1);
    const preview = result.comments[0]?.bodyPreview ?? "";
    expect(preview).toContain("ZYZZYVA-TOKEN");
    expect(preview).not.toContain("**");
    expect(preview.startsWith("…")).toBe(true);
  });

  it("includes users and comments in all-scope counts", async () => {
    const result = await search(token, "Dakota");
    expect(result.counts.users).toBeGreaterThan(0);
    expect(result.counts.total).toBe(
      result.counts.runs +
        result.counts.notebooks +
        result.counts.files +
        result.counts.instruments +
        result.counts.users +
        result.counts.comments
    );
  });

  describe("lab notebooks", () => {
    const INSTRUMENT = "hina-microscope";
    const osmoticUrl = `https://www.notion.so/lab/Cardamom-osmotic-stress-${notionId(1)}`;
    const deletedUrl = `https://www.notion.so/lab/Cardamom-archive-${notionId(4)}`;
    let osmoticId: string;
    let heatId: string;
    let leafId: string;
    let revisionId: string;
    let bulkId: string;

    beforeAll(async () => {
      const [osmotic1, osmotic2, osmoticGone, heat1] = await seedRunsAcquiredAt(
        INSTRUMENT,
        [
          { runId: "nbsearch-osmotic-1", acquiredAt: "2026-01-05T10:00:00Z" },
          { runId: "nbsearch-osmotic-2", acquiredAt: "2026-02-05T10:00:00Z" },
          {
            runId: "nbsearch-osmotic-gone",
            acquiredAt: "2026-02-06T10:00:00Z",
            deleted: true,
          },
          { runId: "nbsearch-heat-1", acquiredAt: "2026-03-05T10:00:00Z" },
        ]
      );
      // A name prefix match, with an older newest run than the next one.
      osmoticId = await seedNotebook({
        url: osmoticUrl,
        name: "Cardamom osmotic stress",
        description: "Salt series on seedlings",
        runIds: [osmotic1, osmotic2, osmoticGone],
      });
      // A match inside the name, with the newest run.
      heatId = await seedNotebook({
        url: `https://www.notion.so/lab/Heat-shock-${notionId(2)}`,
        name: "Heat shock (cardamom)",
        runIds: [heat1],
      });
      // A match in the description only, with no runs.
      leafId = await seedNotebook({
        url: "https://example.com/eln/leaf-imaging",
        name: "Leaf imaging",
        description: "Follow-up to the CARDAMOM screens",
      });
      revisionId = await seedNotebook({
        url: "https://example.com/eln/plate-map",
        name: "Plate map rev.b",
      });
      await seedNotebook({
        url: deletedUrl,
        name: "Cardamom archive",
        deleted: true,
      });

      const bulkRuns = await seedRunsAcquiredAt(
        INSTRUMENT,
        Array.from({ length: 30 }, (_, i) => ({
          runId: `nbsearch-bulk-${String(i).padStart(2, "0")}`,
          acquiredAt: "2025-06-01T10:00:00Z",
        }))
      );
      bulkId = await seedNotebook({
        url: "https://example.com/eln/bulk-screen",
        name: "Bulk screen",
        runIds: bulkRuns,
      });
    });

    it("finds notebooks by name or description, ignoring case", async () => {
      const result = await search(token, "cardamom");
      expect(result.notebooks.map((n) => n.id)).toEqual([
        // A name prefix first, then the newest run, then no runs at all.
        osmoticId,
        heatId,
        leafId,
      ]);
      expect(result.notebooks[0]).toEqual({
        type: "notebook",
        id: osmoticId,
        name: "Cardamom osmotic stress",
        url: osmoticUrl,
        // The deleted run doesn't count.
        runCount: 2,
      });
      expect(result.counts.notebooks).toBe(3);

      const byDescription = await search(token, "salt series", "notebooks");
      expect(byDescription.notebooks.map((n) => n.id)).toEqual([osmoticId]);
    });

    it("leaves deleted notebooks out", async () => {
      const byName = await search(token, "Cardamom archive");
      expect(byName.notebooks).toEqual([]);

      const byLink = await search(token, deletedUrl);
      expect(byLink.notebooks).toEqual([]);
    });

    it("finds only the notebook for a pasted link, in any form of that page", async () => {
      for (const link of [
        osmoticUrl,
        // The same Notion page, renamed, over http, with a query and fragment.
        `http://notion.so/Renamed-page-${notionId(1)}/?pvs=4#top`,
      ]) {
        const result = await search(token, link);
        expect(
          result.notebooks.map((n) => n.id),
          link
        ).toEqual([osmoticId]);
      }

      // A link to a page with no notebook finds none.
      const unknown = await search(
        token,
        `https://www.notion.so/lab/Cardamom-${notionId(9)}`
      );
      expect(unknown.notebooks).toEqual([]);
    });

    it("matches text that could be a link either way", async () => {
      // A link without its scheme finds the notebook for that page.
      const byPage = await search(token, `notion.so/${notionId(1)}`);
      expect(byPage.notebooks.map((n) => n.id)).toEqual([osmoticId]);

      // Dotted text that is no notebook's page still matches a name.
      const byName = await search(token, "rev.b");
      expect(byName.notebooks.map((n) => n.id)).toEqual([revisionId]);

      // A bare Notion page ID matches part of the link.
      const byId = await search(token, notionId(2));
      expect(byId.notebooks.map((n) => n.id)).toEqual([heatId]);
    });

    it("no longer finds runs through their notebooks", async () => {
      for (const query of ["Cardamom osmotic", osmoticUrl]) {
        const result = await search(token, query, "runs");
        expect(
          result.runs.map((r) => r.runId),
          query
        ).toEqual([]);
      }
    });

    it("searches notebooks alone on the notebooks scope", async () => {
      const result = await search(token, "cardamom", "notebooks");
      expect(result.notebooks.length).toBe(3);
      expect(result.runs).toHaveLength(0);
      expect(result.files).toHaveLength(0);
      expect(result.instruments).toHaveLength(0);
      expect(result.users).toHaveLength(0);
      expect(result.comments).toHaveLength(0);
      expect(result.counts.total).toBe(3);
    });

    it("counts every live run in a notebook, past the result cap", async () => {
      const result = await search(token, "Bulk screen", "notebooks");
      expect(result.notebooks).toEqual([
        expect.objectContaining({ id: bulkId, runCount: 30 }),
      ]);
    });
  });
});
