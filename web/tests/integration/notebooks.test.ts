import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  notebookCreated,
  notebookListResponse,
  notebookRunsAdded,
  notebookRunsRemoved,
  notebook as notebookSchema,
  runDetail,
  runListResponse,
} from "@/lib/api/openapi";
import type { GlobalSearchResult } from "@/lib/api/search";
import { instruments } from "@/lib/db/schema";
import {
  NOTEBOOK_RUNS_PER_REQUEST_MAX,
  NOTEBOOKS_PER_RUN_MAX,
} from "@/lib/notebook-links/url";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedSessionCookie,
  seedTestUser,
} from "@/tests/integration/helpers";

// End-to-end tests for lab notebooks:
//
//   - GET/POST /api/v1/notebooks
//   - GET/PATCH/DELETE /api/v1/notebooks/:notebookId
//   - POST /api/v1/notebooks/:notebookId/restore
//   - POST /api/v1/notebooks/:notebookId/runs (add runs)
//   - POST /api/v1/notebooks/:notebookId/runs/remove
//   - the `notebooks` field and the `has_notebook` and `notebook_id` filters
//     on the run responses
//
// A notebook is one page. Only one notebook, deleted or not, can hold a page,
// where "same page" ignores the scheme, `www.`, tracking parameters, the
// fragment, and for Notion, the page title. Reads need `runs:read` and writes
// need `notebooks:write`. A watcher's token may only add or remove its own
// instrument's runs.

const A = "notebooks-a";
const B = "notebooks-b";
const LIFECYCLE = "notebooks-lifecycle";
const FILTER = "notebooks-filter";
const WATCHED = "notebooks-watched";

// Synthetic Notion page IDs: 32 hex digits, the last two from `n`.
function notionId(n: number): string {
  return `3f2a9c01b7e44d1a8c2f4e5d6a7b8c${n.toString(16).padStart(2, "0")}`;
}

function notionUrl(title: string, n: number): string {
  return `https://www.notion.so/lab/${title}-${notionId(n)}`;
}

interface RunRef {
  instrument_id: string;
  run_id: string;
}

function ref(runId: string, instrumentId = A): RunRef {
  return { instrument_id: instrumentId, run_id: runId };
}

function notebookPath(id: string, suffix = ""): string {
  return `/api/v1/notebooks/${id}${suffix}`;
}

function runPath(runId: string, instrumentId = A): string {
  return `/api/v1/instruments/${instrumentId}/runs/${encodeURIComponent(runId)}`;
}

describe("Lab notebooks API", () => {
  let token: string;
  let tokenId: string;
  let userId: string;
  let cookie: string;
  let otherToken: string;
  let otherTokenId: string;
  let readOnlyToken: string;
  let ownerId: string;

  interface As {
    cookie?: string;
    token?: string;
  }

  function call(
    path: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    body?: unknown,
    as: As = { token }
  ): Promise<Response> {
    return api(path, {
      method,
      token: as.token,
      headers: as.cookie ? { Cookie: as.cookie } : undefined,
      body,
    });
  }

  async function createRun(
    runId: string,
    instrumentId = A,
    acquiredAt?: string
  ): Promise<void> {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: runId,
        source: "lambda",
        ...(acquiredAt && { acquired_at: acquiredAt }),
      },
    });
    expect(res.status).toBe(201);
  }

  async function deleteRun(runId: string, instrumentId = A): Promise<void> {
    const res = await api(runPath(runId, instrumentId), {
      method: "DELETE",
      token,
    });
    expect(res.status).toBe(200);
  }

  function postNotebook(body: unknown, as: As = { token }) {
    return call("/api/v1/notebooks", "POST", body, as);
  }

  async function createNotebook(body: unknown, as: As = { token }) {
    const res = await postNotebook(body, as);
    expect(res.status).toBe(201);
    return notebookCreated.parse(await res.json());
  }

  async function getNotebook(id: string) {
    const res = await call(notebookPath(id), "GET");
    expect(res.status).toBe(200);
    return notebookSchema.parse(await res.json());
  }

  async function deleteNotebook(id: string): Promise<void> {
    const res = await call(notebookPath(id), "DELETE");
    expect(res.status).toBe(200);
  }

  function addRuns(id: string, runs: RunRef[], as: As = { token }) {
    return call(notebookPath(id, "/runs"), "POST", { runs }, as);
  }

  function removeRuns(id: string, runs: RunRef[], as: As = { token }) {
    return call(notebookPath(id, "/runs/remove"), "POST", { runs }, as);
  }

  async function runNotebooks(runId: string, instrumentId = A) {
    const res = await api(runPath(runId, instrumentId), { token });
    expect(res.status).toBe(200);
    return runDetail.parse(await res.json()).notebooks;
  }

  async function listNotebooks(
    params: Record<string, string>,
    as: As = { token }
  ) {
    const res = await call(
      `/api/v1/notebooks?${new URLSearchParams(params)}`,
      "GET",
      undefined,
      as
    );
    expect(res.status).toBe(200);
    return notebookListResponse.parse(await res.json());
  }

  // Run IDs from a run list, sorted. Only `runs:read` is needed.
  async function listRunIds(
    path: string,
    params: Record<string, string>
  ): Promise<string[]> {
    const res = await api(`${path}?${new URLSearchParams(params)}`, {
      token: readOnlyToken,
    });
    expect(res.status).toBe(200);
    const body = runListResponse.parse(await res.json());
    return body.data.map((run) => run.run_id).sort();
  }

  beforeAll(async () => {
    await resetDb();

    ({ token, tokenId, userId } = await seedTestUser({
      tokenName: "Notebook Bot",
    }));
    cookie = await seedSessionCookie(userId);
    ({ token: otherToken, tokenId: otherTokenId } = await seedTestUser({
      tokenName: "Other Bot",
    }));
    ({ token: readOnlyToken } = await seedTestUser({ scopes: ["runs:read"] }));
    ({ userId: ownerId } = await seedTestUser({ name: "Olive Owner" }));

    await getTestDb()
      .insert(instruments)
      .values(
        [A, B, LIFECYCLE, FILTER, WATCHED].map((id) => ({
          id,
          displayName: id,
          status: "active" as const,
        }))
      );
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // Creating
  // -------------------------------------------------------------------------

  describe("creating", () => {
    it("creates an empty notebook, trimming the name and dropping a blank description", async () => {
      const url = `${notionUrl("Heat-stress-day-1", 1)}?pvs=4`;
      const created = await createNotebook({
        url,
        name: "  Heat stress day 1 ",
        description: "   ",
      });
      expect(created.runs).toBeNull();
      expect(created.notebook).toMatchObject({
        url,
        url_key: `notion:${notionId(1)}`,
        name: "Heat stress day 1",
        description: null,
        owner: null,
        run_count: 0,
        instrument_count: 0,
        last_run_at: null,
        deleted_at: null,
        created_by: null,
        created_by_token: { id: tokenId, name: "Notebook Bot" },
        updated_by_token: { id: tokenId, name: "Notebook Bot" },
      });
    });

    it("creates a notebook with runs across instruments, with an outcome for each run", async () => {
      await createRun("create-a", A, "2026-02-01T09:00:00Z");
      await createRun("create-b", B, "2026-02-03T09:00:00Z");
      await createRun("create-deleted");
      await deleteRun("create-deleted");

      const created = await createNotebook(
        {
          url: "https://benchling.example.com/entries/etr_12-gel-ladder",
          name: "Gel ladder",
          description: "  Ladder for every gel ",
          owner_id: ownerId,
          runs: [
            ref("create-a"),
            ref("create-b", B),
            ref("create-a"),
            ref("create-deleted"),
            ref("create-missing"),
          ],
        },
        { cookie }
      );

      // A run named twice gets one outcome.
      expect(
        created.runs?.results.map((r) => [r.instrument_id, r.run_id, r.outcome])
      ).toEqual([
        [A, "create-a", "added"],
        [B, "create-b", "added"],
        [A, "create-deleted", "run_deleted"],
        [A, "create-missing", "not_found"],
      ]);
      expect(created.runs?.counts).toEqual({
        added: 2,
        already_in_notebook: 0,
        run_deleted: 1,
        limit_reached: 0,
        not_found: 1,
      });
      expect(created.runs?.notebook_id).toBe(created.notebook.id);
      expect(created.notebook).toMatchObject({
        name: "Gel ladder",
        description: "Ladder for every gel",
        owner: { id: ownerId, displayName: "Olive Owner" },
        run_count: 2,
        instrument_count: 2,
        last_run_at: "2026-02-03T09:00:00.000Z",
        created_by: { id: userId },
        created_by_token: null,
      });
    });

    it("refuses a page another notebook has, even under another title, and names that notebook", async () => {
      const { notebook: first } = await createNotebook({
        url: notionUrl("Old-title", 2),
        name: "Osmotic stress",
      });
      const copy = {
        url: `http://notion.so/Renamed-page-${notionId(2)}?pvs=4#results`,
        name: "Something else",
      };

      const live = await postNotebook(copy);
      expect(live.status).toBe(409);
      const liveBody = await live.json();
      expect(liveBody.error.code).toBe("CONFLICT");
      expect(liveBody.error.details).toEqual({
        notebook_id: first.id,
        deleted: false,
      });

      // A deleted notebook still holds its page, so linking it again offers
      // a restore instead.
      await deleteNotebook(first.id);
      const deleted = await postNotebook(copy);
      expect(deleted.status).toBe(409);
      const deletedBody = await deleted.json();
      expect(deletedBody.error.details).toEqual({
        notebook_id: first.id,
        deleted: true,
      });
      expect(deletedBody.error.message).toMatch(/Restore/);
    });

    it("rejects bad links, names, descriptions, and owners", async () => {
      const url = "https://example.com/eln/rejected";
      const bodies = [
        { url: "javascript:alert(1)", name: "Bad link" },
        { url: "ftp://example.com/x", name: "Bad link" },
        { url: "nope", name: "Bad link" },
        { name: "No link" },
        { url },
        { url, name: "   " },
        { url, name: "two\nlines" },
        { url, name: "n".repeat(201) },
        { url, name: "Long description", description: "d".repeat(2001) },
        { url, name: "Bad runs", runs: [{ instrument_id: A }] },
      ];
      for (const body of bodies) {
        const res = await postNotebook(body);
        expect(res.status).toBe(400);
      }

      const unknownOwner = await postNotebook({
        url,
        name: "Unknown owner",
        owner_id: "no-such-user",
      });
      expect(unknownOwner.status).toBe(400);
      expect((await unknownOwner.json()).error.message).toMatch(/No user/);

      // None of those saved anything, so the page is still free.
      await createNotebook({ url, name: "Accepted" });
    });

    it(`adds at most ${NOTEBOOK_RUNS_PER_REQUEST_MAX} runs per request`, async () => {
      const runs = Array.from(
        { length: NOTEBOOK_RUNS_PER_REQUEST_MAX + 1 },
        (_, i) => ref(`cap-${i}`)
      );
      const url = "https://example.com/eln/cap";
      expect((await postNotebook({ url, name: "Cap", runs })).status).toBe(400);

      const created = await createNotebook({
        url,
        name: "Cap",
        runs: runs.slice(0, NOTEBOOK_RUNS_PER_REQUEST_MAX),
      });
      expect(created.runs?.counts.not_found).toBe(
        NOTEBOOK_RUNS_PER_REQUEST_MAX
      );

      expect((await addRuns(created.notebook.id, runs)).status).toBe(400);
      expect((await removeRuns(created.notebook.id, runs)).status).toBe(400);
    });
  });

  // -------------------------------------------------------------------------
  // Listing and reading
  // -------------------------------------------------------------------------

  describe("listing and reading", () => {
    // Every notebook here mentions "zephyr" in its name, description, or
    // link, and no notebook from another test does.
    let growth: string;
    let plates: string;
    let strains: string;
    let gone: string;
    let listOwnerId: string;

    beforeAll(async () => {
      ({ userId: listOwnerId } = await seedTestUser({ name: "Lena Lister" }));
      await createRun("zephyr-1", A, "2026-01-05T00:00:00Z");
      await createRun("zephyr-2a", A, "2026-01-01T00:00:00Z");
      await createRun("zephyr-2b", B, "2026-01-03T00:00:00Z");

      growth = (
        await createNotebook({
          url: "https://example.com/eln/zephyr-1",
          name: "Zephyr growth curves",
          owner_id: listOwnerId,
          runs: [ref("zephyr-1")],
        })
      ).notebook.id;
      plates = (
        await createNotebook({
          url: notionUrl("Zephyr-plates", 3),
          name: "Plate reader zephyr",
          runs: [ref("zephyr-2a"), ref("zephyr-2b", B)],
        })
      ).notebook.id;
      strains = (
        await createNotebook({
          url: "https://example.com/eln/strains",
          name: "Unrelated name",
          description: "Notes on zephyr strains",
        })
      ).notebook.id;
      gone = (
        await createNotebook({
          url: "https://example.com/eln/zephyr-4",
          name: "Deleted zephyr",
        })
      ).notebook.id;
      await deleteNotebook(gone);
    });

    async function listedIds(params: Record<string, string>) {
      return (await listNotebooks(params)).data.map((n) => n.id);
    }

    it("matches a name, a description, or a link, ignoring case", async () => {
      const listed = await listNotebooks({ q: "zephyr" });
      expect(listed.data.map((n) => n.id).sort()).toEqual(
        [growth, plates, strains].sort()
      );
      expect(listed.pagination.total).toBe(3);

      expect(await listedIds({ q: "GROWTH CURVES" })).toEqual([growth]);
      expect(await listedIds({ q: "zephyr strains" })).toEqual([strains]);
    });

    it("matches a pasted link only to the notebook for that page", async () => {
      expect(
        await listedIds({
          q: `https://notion.so/Another-title-${notionId(3)}?pvs=4`,
        })
      ).toEqual([plates]);
      // Without `https://`, with `www.`, a trailing slash, and a tracking
      // parameter.
      expect(
        await listedIds({ q: "www.example.com/eln/zephyr-1/?utm_source=slack" })
      ).toEqual([growth]);
      // A link to a page no notebook has matches nothing, even though its
      // text appears in other links.
      expect(await listedIds({ q: "https://example.com/eln/zephyr" })).toEqual(
        []
      );
    });

    it("matches dotted text by name, not only as a link", async () => {
      // "assay.final" could also be a link without its `https://`.
      const { notebook } = await createNotebook({
        url: "https://example.com/eln/dotted",
        name: "Plate assay.final",
      });
      expect(await listedIds({ q: "assay.final" })).toEqual([notebook.id]);
    });

    it("lists deleted notebooks only with include_deleted", async () => {
      const all = await listNotebooks({ q: "zephyr", include_deleted: "true" });
      expect(all.pagination.total).toBe(4);
      const deleted = all.data.find((n) => n.id === gone);
      expect(deleted?.deleted_at).not.toBeNull();
      expect(deleted?.deleted_by_token?.id).toBe(tokenId);

      const link = "https://example.com/eln/zephyr-4";
      expect(await listedIds({ q: link })).toEqual([]);
      expect(await listedIds({ q: link, include_deleted: "true" })).toEqual([
        gone,
      ]);
    });

    it("filters by owner", async () => {
      const listed = await listNotebooks({ owner_id: listOwnerId });
      expect(listed.data.map((n) => n.id)).toEqual([growth]);
      expect(listed.data[0].owner?.displayName).toBe("Lena Lister");
    });

    it("reports run counts, instruments, and the newest run", async () => {
      const [growthNotebook, platesNotebook] = await Promise.all([
        getNotebook(growth),
        getNotebook(plates),
      ]);
      expect(growthNotebook).toMatchObject({
        run_count: 1,
        instrument_count: 1,
        last_run_at: "2026-01-05T00:00:00.000Z",
      });
      expect(platesNotebook).toMatchObject({
        run_count: 2,
        instrument_count: 2,
        last_run_at: "2026-01-03T00:00:00.000Z",
      });
    });

    it("sorts by newest run by default, and by name, run count, or creation", async () => {
      const q = "zephyr";
      // A notebook with no runs goes last either way.
      expect(await listedIds({ q })).toEqual([growth, plates, strains]);
      expect(await listedIds({ q, order: "asc" })).toEqual([
        plates,
        growth,
        strains,
      ]);
      expect(await listedIds({ q, sort: "name" })).toEqual([
        plates,
        strains,
        growth,
      ]);
      expect(await listedIds({ q, sort: "name", order: "desc" })).toEqual([
        growth,
        strains,
        plates,
      ]);
      expect(await listedIds({ q, sort: "run_count" })).toEqual([
        plates,
        growth,
        strains,
      ]);
      expect(await listedIds({ q, sort: "created", order: "asc" })).toEqual([
        growth,
        plates,
        strains,
      ]);
    });

    it("refuses an unknown sort or order", async () => {
      const cases: Record<string, string>[] = [
        { sort: "bogus" },
        { order: "sideways" },
      ];
      for (const params of cases) {
        const res = await call(
          `/api/v1/notebooks?${new URLSearchParams(params)}`,
          "GET"
        );
        expect(res.status).toBe(400);
      }
    });

    it("pages through the results", async () => {
      const first = await listNotebooks({
        q: "zephyr",
        sort: "name",
        per_page: "2",
      });
      expect(first.data.map((n) => n.id)).toEqual([plates, strains]);
      expect(first.pagination).toEqual({
        page: 1,
        per_page: 2,
        total: 3,
        total_pages: 2,
      });
      const second = await listNotebooks({
        q: "zephyr",
        sort: "name",
        per_page: "2",
        page: "2",
      });
      expect(second.data.map((n) => n.id)).toEqual([growth]);
    });

    it("gets one notebook, deleted or not, and 404s for anything else", async () => {
      const listed = await listNotebooks({ q: "zephyr growth" });
      expect(await getNotebook(growth)).toEqual(listed.data[0]);
      expect((await getNotebook(gone)).deleted_at).not.toBeNull();

      for (const id of [crypto.randomUUID(), "not-a-uuid"]) {
        const res = await call(notebookPath(id), "GET");
        expect(res.status).toBe(404);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------

  describe("editing", () => {
    it("renames a notebook and records who changed it", async () => {
      await createRun("rename-run");
      const { notebook } = await createNotebook({
        url: "https://example.com/eln/rename",
        name: "Before",
        runs: [ref("rename-run")],
      });

      const res = await call(
        notebookPath(notebook.id),
        "PATCH",
        { name: "  After " },
        { token: otherToken }
      );
      expect(res.status).toBe(200);
      const updated = notebookSchema.parse(await res.json());
      expect(updated.name).toBe("After");
      expect(updated.created_by_token?.id).toBe(tokenId);
      expect(updated.updated_by_token?.id).toBe(otherTokenId);

      // Runs show the notebook's one shared name.
      expect((await runNotebooks("rename-run")).map((n) => n.name)).toEqual([
        "After",
      ]);
    });

    it("sets and clears the description and owner", async () => {
      const { notebook } = await createNotebook({
        url: "https://example.com/eln/clearing",
        name: "Clearing",
        description: "Day 1",
        owner_id: ownerId,
      });
      const patch = async (body: unknown) => {
        const res = await call(notebookPath(notebook.id), "PATCH", body);
        expect(res.status).toBe(200);
        return notebookSchema.parse(await res.json());
      };

      const cleared = await patch({ description: null, owner_id: null });
      expect(cleared.description).toBeNull();
      expect(cleared.owner).toBeNull();
      expect(cleared.name).toBe("Clearing");

      const set = await patch({ description: " Day 2 ", owner_id: ownerId });
      expect(set.description).toBe("Day 2");
      expect(set.owner?.id).toBe(ownerId);

      // Fields left out stay; a blank description clears it.
      const blank = await patch({ description: "  " });
      expect(blank.description).toBeNull();
      expect(blank.owner?.id).toBe(ownerId);
    });

    it('makes the signed-in person the owner with owner_id "me", but not for a token', async () => {
      const { notebook } = await createNotebook(
        { url: "https://example.com/eln/mine", name: "Mine", owner_id: "me" },
        { cookie }
      );
      expect(notebook.owner?.id).toBe(userId);

      const cleared = await call(
        notebookPath(notebook.id),
        "PATCH",
        { owner_id: null },
        { cookie }
      );
      expect(notebookSchema.parse(await cleared.json()).owner).toBeNull();
      const mine = await call(
        notebookPath(notebook.id),
        "PATCH",
        { owner_id: "me" },
        { cookie }
      );
      expect(notebookSchema.parse(await mine.json()).owner?.id).toBe(userId);

      // A token has no person behind it.
      const fromToken = await postNotebook({
        url: "https://example.com/eln/not-mine",
        name: "Not mine",
        owner_id: "me",
      });
      expect(fromToken.status).toBe(400);
      const patchFromToken = await call(notebookPath(notebook.id), "PATCH", {
        owner_id: "me",
      });
      expect(patchFromToken.status).toBe(400);
    });

    it("changes the link, and keeps its own page under another spelling", async () => {
      await createRun("relink-run");
      const { notebook } = await createNotebook({
        url: notionUrl("Gel-ladder", 4),
        name: "Gel ladder",
        runs: [ref("relink-run")],
      });

      const renamedPage = `https://notion.so/Gel-ladder-v2-${notionId(4)}`;
      const sameRes = await call(notebookPath(notebook.id), "PATCH", {
        url: renamedPage,
      });
      expect(sameRes.status).toBe(200);
      const same = notebookSchema.parse(await sameRes.json());
      expect(same.url).toBe(renamedPage);
      expect(same.url_key).toBe(`notion:${notionId(4)}`);

      const movedRes = await call(notebookPath(notebook.id), "PATCH", {
        url: "https://example.com/eln/gel-ladder",
      });
      expect(movedRes.status).toBe(200);
      const moved = notebookSchema.parse(await movedRes.json());
      expect(moved.url_key).toBe("example.com/eln/gel-ladder");
      expect((await runNotebooks("relink-run"))[0].url).toBe(
        "https://example.com/eln/gel-ladder"
      );

      // The old page is free again.
      await createNotebook({ url: notionUrl("Gel-ladder", 4), name: "Reused" });
    });

    it("refuses a link another notebook has", async () => {
      const { notebook: first } = await createNotebook({
        url: "https://example.com/eln/clash-a",
        name: "Clash A",
      });
      const { notebook: second } = await createNotebook({
        url: "https://example.com/eln/clash-b",
        name: "Clash B",
      });

      const res = await call(notebookPath(second.id), "PATCH", {
        url: "http://www.example.com/eln/clash-a/?utm_source=slack",
      });
      expect(res.status).toBe(409);
      expect((await res.json()).error.details).toEqual({
        notebook_id: first.id,
        deleted: false,
      });
      expect((await getNotebook(second.id)).url).toBe(
        "https://example.com/eln/clash-b"
      );
    });

    it("refuses an unknown owner, an empty edit, and a deleted or missing notebook", async () => {
      const { notebook } = await createNotebook({
        url: "https://example.com/eln/edit-refusals",
        name: "Edit refusals",
      });
      const path = notebookPath(notebook.id);

      const unknownOwner = await call(path, "PATCH", {
        owner_id: "no-such-user",
      });
      expect(unknownOwner.status).toBe(400);
      expect((await call(path, "PATCH", {})).status).toBe(400);
      expect((await call(path, "PATCH", { name: "" })).status).toBe(400);

      await deleteNotebook(notebook.id);
      const deleted = await call(path, "PATCH", { name: "Too late" });
      expect(deleted.status).toBe(409);
      expect((await getNotebook(notebook.id)).name).toBe("Edit refusals");

      const missing = await call(notebookPath(crypto.randomUUID()), "PATCH", {
        name: "Nobody",
      });
      expect(missing.status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // Deleting and restoring
  // -------------------------------------------------------------------------

  describe("deleting and restoring", () => {
    it("hides a deleted notebook from its runs and brings it back on restore", async () => {
      await createRun("life-in", LIFECYCLE);
      await createRun("life-bare", LIFECYCLE);
      const { notebook } = await createNotebook({
        url: "https://example.com/eln/lifecycle",
        name: "Lifecycle",
        runs: [ref("life-in", LIFECYCLE)],
      });
      const runs = `/api/v1/instruments/${LIFECYCLE}/runs`;
      expect(await listRunIds(runs, { has_notebook: "true" })).toEqual([
        "life-in",
      ]);

      const res = await call(notebookPath(notebook.id), "DELETE");
      expect(res.status).toBe(200);
      const deleted = notebookSchema.parse(await res.json());
      expect(deleted.deleted_at).not.toBeNull();
      expect(deleted.deleted_by_token?.id).toBe(tokenId);
      // Its runs keep their place in it.
      expect(deleted.run_count).toBe(1);

      expect(await runNotebooks("life-in", LIFECYCLE)).toEqual([]);
      expect(await listRunIds(runs, { has_notebook: "true" })).toEqual([]);
      expect(await listRunIds(runs, { has_notebook: "false" })).toEqual([
        "life-bare",
        "life-in",
      ]);
      // The notebook's own run list still shows what a restore brings back,
      // though the run itself no longer lists the notebook.
      const inNotebook = runListResponse.parse(
        await (
          await api(`${runs}?notebook_id=${notebook.id}`, { token })
        ).json()
      );
      expect(inNotebook.data.map((run) => run.run_id)).toEqual(["life-in"]);
      expect(inNotebook.data[0].notebooks).toEqual([]);
      expect(
        (await listNotebooks({ q: "Lifecycle" })).data.map((n) => n.id)
      ).toEqual([]);

      const restoreRes = await call(
        notebookPath(notebook.id, "/restore"),
        "POST",
        undefined,
        { token: otherToken }
      );
      expect(restoreRes.status).toBe(200);
      const restored = notebookSchema.parse(await restoreRes.json());
      expect(restored.deleted_at).toBeNull();
      expect(restored.deleted_by).toBeNull();
      expect(restored.deleted_by_token).toBeNull();
      expect(restored.updated_by_token?.id).toBe(otherTokenId);

      expect(
        (await runNotebooks("life-in", LIFECYCLE)).map((n) => n.id)
      ).toEqual([notebook.id]);
      expect(await listRunIds(runs, { has_notebook: "true" })).toEqual([
        "life-in",
      ]);
    });

    it("refuses to delete twice, restore a live notebook, or change a deleted one's runs", async () => {
      await createRun("life-locked", LIFECYCLE);
      const { notebook } = await createNotebook({
        url: "https://example.com/eln/lifecycle-locked",
        name: "Locked",
        runs: [ref("life-locked", LIFECYCLE)],
      });
      const restore = () => call(notebookPath(notebook.id, "/restore"), "POST");

      expect((await restore()).status).toBe(409);
      await deleteNotebook(notebook.id);
      expect((await call(notebookPath(notebook.id), "DELETE")).status).toBe(
        409
      );

      const run = [ref("life-locked", LIFECYCLE)];
      expect((await addRuns(notebook.id, run)).status).toBe(409);
      expect((await removeRuns(notebook.id, run)).status).toBe(409);
      expect((await getNotebook(notebook.id)).run_count).toBe(1);

      expect((await restore()).status).toBe(200);
      expect((await restore()).status).toBe(409);

      for (const id of [crypto.randomUUID(), "not-a-uuid"]) {
        expect((await call(notebookPath(id), "DELETE")).status).toBe(404);
        expect((await call(notebookPath(id, "/restore"), "POST")).status).toBe(
          404
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // Adding and removing runs
  // -------------------------------------------------------------------------

  describe("adding and removing runs", () => {
    it("reports an outcome for each run added", async () => {
      await createRun("add-new");
      await createRun("add-in");
      await createRun("add-deleted");
      await createRun("add-other", B);
      await deleteRun("add-deleted");
      const { notebook } = await createNotebook({
        url: "https://example.com/eln/adding",
        name: "Adding",
        runs: [ref("add-in")],
      });

      const res = await addRuns(notebook.id, [
        ref("add-new"),
        ref("add-in"),
        ref("add-deleted"),
        ref("add-missing"),
        ref("add-other", B),
      ]);
      expect(res.status).toBe(200);
      const body = notebookRunsAdded.parse(await res.json());
      expect(body.notebook_id).toBe(notebook.id);
      expect(body.results.map((r) => [r.run_id, r.outcome])).toEqual([
        ["add-new", "added"],
        ["add-in", "already_in_notebook"],
        ["add-deleted", "run_deleted"],
        ["add-missing", "not_found"],
        ["add-other", "added"],
      ]);
      expect(body.counts).toEqual({
        added: 2,
        already_in_notebook: 1,
        run_deleted: 1,
        limit_reached: 0,
        not_found: 1,
      });

      expect(await getNotebook(notebook.id)).toMatchObject({
        run_count: 3,
        instrument_count: 2,
      });
      const [linked] = await runNotebooks("add-new");
      expect(linked.id).toBe(notebook.id);
      expect(linked.linked_by_token).toEqual({
        id: tokenId,
        name: "Notebook Bot",
      });
    });

    it(`stops a run at ${NOTEBOOKS_PER_RUN_MAX} notebooks, deleted ones included`, async () => {
      await createRun("add-full");
      const ids: string[] = [];
      for (let i = 0; i < NOTEBOOKS_PER_RUN_MAX; i += 1) {
        const created = await createNotebook({
          url: `https://example.com/eln/full-${i}`,
          name: `Full ${i}`,
          runs: [ref("add-full")],
        });
        expect(created.runs?.results[0].outcome).toBe("added");
        ids.push(created.notebook.id);
      }
      // A deleted notebook keeps its runs for a restore, so it still counts.
      await deleteNotebook(ids[0]);

      const { notebook } = await createNotebook({
        url: "https://example.com/eln/full-extra",
        name: "One too many",
      });
      const res = await addRuns(notebook.id, [ref("add-full")]);
      const body = notebookRunsAdded.parse(await res.json());
      expect(body.results[0].outcome).toBe("limit_reached");

      const onCreate = await createNotebook({
        url: "https://example.com/eln/full-extra-2",
        name: "Also too many",
        runs: [ref("add-full")],
      });
      expect(onCreate.runs?.results[0].outcome).toBe("limit_reached");
      expect(onCreate.notebook.run_count).toBe(0);
    });

    it("reports an outcome for each run removed, and keeps an emptied notebook", async () => {
      for (const runId of ["rm-a", "rm-b", "rm-out", "rm-deleted"]) {
        await createRun(runId);
      }
      const { notebook } = await createNotebook({
        url: "https://example.com/eln/removing",
        name: "Removing",
        runs: [ref("rm-a"), ref("rm-b"), ref("rm-deleted")],
      });
      await deleteRun("rm-deleted");

      const res = await removeRuns(notebook.id, [
        ref("rm-a"),
        ref("rm-out"),
        ref("rm-deleted"),
        ref("rm-missing"),
      ]);
      expect(res.status).toBe(200);
      const body = notebookRunsRemoved.parse(await res.json());
      expect(body.results.map((r) => [r.run_id, r.outcome])).toEqual([
        ["rm-a", "removed"],
        ["rm-out", "not_in_notebook"],
        ["rm-deleted", "run_deleted"],
        ["rm-missing", "not_found"],
      ]);
      expect(body.counts).toEqual({
        removed: 1,
        not_in_notebook: 1,
        run_deleted: 1,
        not_found: 1,
      });
      expect(await runNotebooks("rm-a")).toEqual([]);

      const last = notebookRunsRemoved.parse(
        await (await removeRuns(notebook.id, [ref("rm-b")])).json()
      );
      expect(last.counts.removed).toBe(1);
      const emptied = await getNotebook(notebook.id);
      expect(emptied.deleted_at).toBeNull();
      expect(emptied.run_count).toBe(0);
    });

    it("404s for an unknown notebook and 400s for no runs", async () => {
      await createRun("add-nowhere");
      for (const id of [crypto.randomUUID(), "not-a-uuid"]) {
        expect((await addRuns(id, [ref("add-nowhere")])).status).toBe(404);
        expect((await removeRuns(id, [ref("add-nowhere")])).status).toBe(404);
      }

      const { notebook } = await createNotebook({
        url: "https://example.com/eln/no-runs",
        name: "No runs",
      });
      expect((await addRuns(notebook.id, [])).status).toBe(400);
      expect((await removeRuns(notebook.id, [])).status).toBe(400);
      expect(
        (await call(notebookPath(notebook.id, "/runs"), "POST", {})).status
      ).toBe(400);
    });

    it("bumps a run's updated time when it joins or leaves a notebook, but not when the notebook changes", async () => {
      await createRun("touch-run");
      const updatedAt = async (): Promise<string> =>
        runDetail.parse(
          await (await api(runPath("touch-run"), { token })).json()
        ).updated_at;

      const before = await updatedAt();
      const { notebook } = await createNotebook({
        url: "https://example.com/eln/touch",
        name: "Touch",
        runs: [ref("touch-run")],
      });
      const afterAdd = await updatedAt();
      expect(afterAdd > before).toBe(true);

      await call(notebookPath(notebook.id), "PATCH", { name: "Touched" });
      await deleteNotebook(notebook.id);
      await call(notebookPath(notebook.id, "/restore"), "POST");
      expect(await updatedAt()).toBe(afterAdd);

      await removeRuns(notebook.id, [ref("touch-run")]);
      expect((await updatedAt()) > afterAdd).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Runs and their notebooks
  // -------------------------------------------------------------------------

  describe("runs and their notebooks", () => {
    it("lists a run's notebooks in run detail, oldest first", async () => {
      await createRun("detail-run");
      const first = await createNotebook(
        {
          url: "https://example.com/eln/detail-1",
          name: "Detail one",
          runs: [ref("detail-run")],
        },
        { cookie }
      );
      const second = await createNotebook({
        url: "https://example.com/eln/detail-2",
        name: "Detail two",
      });
      expect(
        (await addRuns(second.notebook.id, [ref("detail-run")])).status
      ).toBe(200);

      const listed = await runNotebooks("detail-run");
      expect(listed.map((n) => n.name)).toEqual(["Detail one", "Detail two"]);
      expect(listed[0]).toMatchObject({
        id: first.notebook.id,
        url: "https://example.com/eln/detail-1",
        url_key: "example.com/eln/detail-1",
        linked_by: { id: userId },
        linked_by_token: null,
      });
      expect(listed[1].linked_by).toBeNull();
      expect(listed[1].linked_by_token).toEqual({
        id: tokenId,
        name: "Notebook Bot",
      });
    });

    it("filters both run lists by has_notebook and notebook_id", async () => {
      for (const runId of ["f-in", "f-bare", "f-deleted-nb", "f-deleted-run"]) {
        await createRun(runId, FILTER);
      }
      await createRun("f-in-b", B);
      const { notebook: x } = await createNotebook({
        url: "https://example.com/eln/filter-x",
        name: "Filter X",
        runs: [
          ref("f-in", FILTER),
          ref("f-in-b", B),
          ref("f-deleted-run", FILTER),
        ],
      });
      const { notebook: y } = await createNotebook({
        url: "https://example.com/eln/filter-y",
        name: "Filter Y",
        runs: [ref("f-deleted-nb", FILTER)],
      });
      await deleteNotebook(y.id);
      await deleteRun("f-deleted-run", FILTER);

      const perInstrument = `/api/v1/instruments/${FILTER}/runs`;
      const everywhere = "/api/v1/instrument-runs";

      // A deleted notebook doesn't count for `has_notebook`.
      expect(await listRunIds(perInstrument, { has_notebook: "true" })).toEqual(
        ["f-in"]
      );
      expect(
        await listRunIds(perInstrument, { has_notebook: "false" })
      ).toEqual(["f-bare", "f-deleted-nb"]);
      expect(
        await listRunIds(everywhere, {
          instrument_id: FILTER,
          has_notebook: "true",
        })
      ).toEqual(["f-in"]);

      expect(await listRunIds(perInstrument, { notebook_id: x.id })).toEqual([
        "f-in",
      ]);
      expect(
        await listRunIds(perInstrument, {
          notebook_id: x.id,
          include_deleted: "true",
        })
      ).toEqual(["f-deleted-run", "f-in"]);
      expect(await listRunIds(everywhere, { notebook_id: x.id })).toEqual([
        "f-in",
        "f-in-b",
      ]);
      // A deleted notebook still lists its runs.
      expect(await listRunIds(everywhere, { notebook_id: y.id })).toEqual([
        "f-deleted-nb",
      ]);
      // An ID that is no notebook's matches nothing; a blank one is ignored.
      for (const notebookId of [crypto.randomUUID(), "not-a-uuid"]) {
        expect(
          await listRunIds(everywhere, { notebook_id: notebookId })
        ).toEqual([]);
      }
      expect(await listRunIds(perInstrument, { notebook_id: " " })).toEqual([
        "f-bare",
        "f-deleted-nb",
        "f-in",
      ]);

      // Each run lists its live notebooks.
      const listed = runListResponse.parse(
        await (await api(`${everywhere}?notebook_id=${x.id}`, { token })).json()
      );
      for (const run of listed.data) {
        expect(run.notebooks.map((n) => [n.id, n.name])).toEqual([
          [x.id, "Filter X"],
        ]);
      }
    });

    it("finds runs in global search by a pasted link or a notebook's name, but not through a deleted notebook", async () => {
      await createRun("search-linked");
      const { notebook } = await createNotebook({
        url: notionUrl("Cardamom-osmotic-stress", 5),
        name: "Cardamom osmotic stress",
        runs: [ref("search-linked")],
      });
      const search = async (q: string) => {
        const params = new URLSearchParams({ q, scope: "runs" });
        const res = await api(`/api/v1/search?${params}`, { token });
        expect(res.status).toBe(200);
        return (await res.json()) as GlobalSearchResult;
      };

      const pasted = await search(
        `http://notion.so/Renamed-page-${notionId(5)}/?pvs=4#top`
      );
      const hit = pasted.runs.find((run) => run.runId === "search-linked");
      expect(hit?.matchReason).toBe("notebook_link");
      expect(hit?.matchedNotebook).toEqual({
        id: notebook.id,
        name: "Cardamom osmotic stress",
        url: notebook.url,
      });

      const byName = await search("cardamom");
      expect(byName.runs.map((run) => run.runId)).toContain("search-linked");

      await deleteNotebook(notebook.id);
      const afterDelete = await search("cardamom");
      expect(afterDelete.runs.map((run) => run.runId)).not.toContain(
        "search-linked"
      );
    });
  });

  // -------------------------------------------------------------------------
  // Scopes
  // -------------------------------------------------------------------------

  describe("scopes", () => {
    it("lets runs:read list and read notebooks, but not change them", async () => {
      await createRun("scope-run");
      const { notebook } = await createNotebook({
        url: "https://example.com/eln/scopes",
        name: "Scopes",
      });
      const readOnly = { token: readOnlyToken };

      await listNotebooks({ q: "Scopes" }, readOnly);
      expect(
        (await call(notebookPath(notebook.id), "GET", undefined, readOnly))
          .status
      ).toBe(200);

      const writes: [string, "POST" | "PATCH" | "DELETE", unknown][] = [
        [
          "/api/v1/notebooks",
          "POST",
          { url: "https://example.com/eln/scopes-2", name: "Nope" },
        ],
        [notebookPath(notebook.id), "PATCH", { name: "Nope" }],
        [notebookPath(notebook.id), "DELETE", undefined],
        [notebookPath(notebook.id, "/restore"), "POST", undefined],
        [
          notebookPath(notebook.id, "/runs"),
          "POST",
          { runs: [ref("scope-run")] },
        ],
        [
          notebookPath(notebook.id, "/runs/remove"),
          "POST",
          { runs: [ref("scope-run")] },
        ],
      ];
      for (const [path, method, body] of writes) {
        const res = await call(path, method, body, readOnly);
        expect(res.status).toBe(403);
        expect((await res.json()).error.message).toMatch(
          /missing required scope: notebooks:write/
        );
      }

      const { token: writeOnly } = await seedTestUser({
        scopes: ["notebooks:write"],
      });
      const res = await call("/api/v1/notebooks", "GET", undefined, {
        token: writeOnly,
      });
      expect(res.status).toBe(403);
      expect((await res.json()).error.message).toMatch(
        /missing required scope: runs:read/
      );
    });

    it("accepts a token that still stores the old runs:link scope", async () => {
      await createRun("legacy-run");
      const { token: legacy } = await seedTestUser({
        scopes: ["runs:read", "runs:link"],
      });
      const as = { token: legacy };

      const created = await createNotebook(
        {
          url: "https://example.com/eln/legacy",
          name: "Legacy",
          runs: [ref("legacy-run")],
        },
        as
      );
      expect(created.runs?.counts.added).toBe(1);
      const id = created.notebook.id;
      expect(
        (await call(notebookPath(id), "PATCH", { name: "Legacy 2" }, as)).status
      ).toBe(200);
      expect((await removeRuns(id, [ref("legacy-run")], as)).status).toBe(200);
      expect(
        (await call(notebookPath(id), "DELETE", undefined, as)).status
      ).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // Watcher tokens
  // -------------------------------------------------------------------------

  describe("a watcher's token", () => {
    let watcherToken: string;
    let notebookId: string;

    beforeAll(async () => {
      ({ token: watcherToken } = await seedTestUser({
        scopes: ["runs:read", "watchers:report", "notebooks:write"],
      }));
      const registered = await api("/api/v1/watchers/register", {
        method: "POST",
        token: watcherToken,
        body: { instrument_id: WATCHED, hostname: "pc-notebooks" },
      });
      expect(registered.status).toBe(201);

      await createRun("watched-run", WATCHED);
      await createRun("unwatched-run", A);
      const created = await createNotebook({
        url: "https://example.com/eln/watcher",
        name: "Watcher target",
      });
      notebookId = created.notebook.id;
    });

    it("can't create, edit, delete, or restore a notebook", async () => {
      const as = { token: watcherToken };
      const requests: [string, "POST" | "PATCH" | "DELETE", unknown][] = [
        [
          "/api/v1/notebooks",
          "POST",
          { url: "https://example.com/eln/watcher-2", name: "From a lab PC" },
        ],
        [notebookPath(notebookId), "PATCH", { name: "Renamed by a lab PC" }],
        [notebookPath(notebookId), "DELETE", undefined],
        [notebookPath(notebookId, "/restore"), "POST", undefined],
      ];
      for (const [path, method, body] of requests) {
        const res = await call(path, method, body, as);
        expect(res.status).toBe(403);
        const error = (await res.json()).error;
        expect(error.code).toBe("FORBIDDEN");
        expect(error.message).toMatch(/can't create or change notebooks/);
      }

      const unchanged = await getNotebook(notebookId);
      expect(unchanged.name).toBe("Watcher target");
      expect(unchanged.deleted_at).toBeNull();
      expect(
        (await listNotebooks({ q: "From a lab PC" })).pagination.total
      ).toBe(0);
    });

    it("can add and remove its own instrument's runs", async () => {
      const as = { token: watcherToken };
      const run = [ref("watched-run", WATCHED)];

      const added = await addRuns(notebookId, run, as);
      expect(added.status).toBe(200);
      expect(notebookRunsAdded.parse(await added.json()).counts.added).toBe(1);

      const removed = await removeRuns(notebookId, run, as);
      expect(removed.status).toBe(200);
      expect(
        notebookRunsRemoved.parse(await removed.json()).counts.removed
      ).toBe(1);
    });

    it("is refused for the whole request when a run is on another instrument", async () => {
      const as = { token: watcherToken };
      const runs = [ref("watched-run", WATCHED), ref("unwatched-run", A)];

      for (const res of [
        await addRuns(notebookId, runs, as),
        await removeRuns(notebookId, runs, as),
      ]) {
        expect(res.status).toBe(403);
        expect((await res.json()).error.message).toMatch(
          /not authorized for this instrument/
        );
      }
      expect(await runNotebooks("watched-run", WATCHED)).toEqual([]);
    });
  });
});
