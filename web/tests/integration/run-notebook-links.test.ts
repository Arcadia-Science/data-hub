import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bulkAddNotebookLinkResult,
  bulkRemoveNotebookLinksResult,
  notebookLink,
  notebookLinkDeleted,
  notebookLinksListResponse,
  runDetail,
  runListResponse,
} from "@/lib/api/openapi";
import type { GlobalSearchResult } from "@/lib/api/search";
import { instruments } from "@/lib/db/schema";
import { NOTEBOOK_LINKS_PER_RUN_MAX } from "@/lib/notebook-links/url";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedSessionCookie,
  seedTestUser,
} from "@/tests/integration/helpers";

// End-to-end tests for lab notebook links on runs:
//
//   - GET/POST /api/v1/instruments/:instrumentId/runs/:runId/notebook-links
//   - PATCH/DELETE .../notebook-links/:linkId
//   - POST /api/v1/instrument-runs/notebook-links (bulk add)
//   - POST /api/v1/instrument-runs/notebook-links/remove (bulk remove)
//
// Any signed-in person, or a token with `runs:link`, can change any link. A
// run can't hold two links to the same page, where "same page" ignores the
// scheme, `www.`, query tracking parameters, the fragment, and for Notion,
// the page title. Deleted runs keep their links but can't change them.
describe("Run notebook links API", () => {
  let token: string;
  let tokenId: string;
  let userId: string;
  let cookie: string;
  let otherToken: string;
  let otherTokenId: string;
  let readOnlyToken: string;

  const instrumentId = "notebook-links-instrument";
  const otherInstrumentId = "notebook-links-instrument-2";
  const NOTION_ID = "3f2a9c01b7e44d1a8c2f4e5d6a7b8c9d";

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

    await getTestDb()
      .insert(instruments)
      .values([
        { id: instrumentId, displayName: "Notebook Test", status: "active" },
        {
          id: otherInstrumentId,
          displayName: "Notebook Test 2",
          status: "active",
        },
      ]);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  async function createRun(runId: string, onInstrument = instrumentId) {
    const res = await api(`/api/v1/instruments/${onInstrument}/runs`, {
      method: "POST",
      token,
      body: { run_id: runId, source: "lambda" },
    });
    expect([200, 201]).toContain(res.status);
  }

  async function deleteRun(runId: string) {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs/${runId}`, {
      method: "DELETE",
      token,
    });
    expect(res.status).toBe(200);
  }

  function linksPath(runId: string, onInstrument = instrumentId): string {
    return `/api/v1/instruments/${onInstrument}/runs/${encodeURIComponent(runId)}/notebook-links`;
  }

  async function addLink(
    runId: string,
    body: { url: string; label?: string | null },
    as: { token?: string; cookie?: string } = { token }
  ) {
    return await api(linksPath(runId), {
      method: "POST",
      token: as.token,
      headers: as.cookie ? { Cookie: as.cookie } : undefined,
      body,
    });
  }

  // -------------------------------------------------------------------------
  // One link at a time
  // -------------------------------------------------------------------------

  it("needs runs:link to add a link", async () => {
    await createRun("run-scope");
    const res = await addLink(
      "run-scope",
      { url: "https://example.com/eln/1" },
      { token: readOnlyToken }
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.message).toMatch(/runs:link/);
  });

  it("returns 404 for an unknown run", async () => {
    const res = await addLink("no-such-run", { url: "https://example.com" });
    expect(res.status).toBe(404);
  });

  it("adds a link as a token, then lists it", async () => {
    await createRun("run-add");
    const res = await addLink("run-add", {
      url: `https://www.notion.so/arcadia/Heat-stress-day-1-${NOTION_ID}?pvs=4`,
      label: "  Day 1 heat stress ",
    });
    expect(res.status).toBe(201);
    const created = notebookLink.parse(await res.json());
    expect(created.label).toBe("Day 1 heat stress");
    expect(created.display_name).toBe("Day 1 heat stress");
    expect(created.url_key).toBe(`notion:${NOTION_ID}`);
    expect(created.created_by).toBeNull();
    expect(created.created_by_token).toEqual({
      id: tokenId,
      name: "Notebook Bot",
    });

    const list = await api(linksPath("run-add"), { token: readOnlyToken });
    expect(list.status).toBe(200);
    const listed = notebookLinksListResponse.parse(await list.json());
    expect(listed.notebook_links.map((link) => link.id)).toEqual([created.id]);
  });

  it("records the person when a signed-in session adds a link", async () => {
    await createRun("run-session");
    const res = await addLink(
      "run-session",
      { url: "https://example.com/eln/session" },
      { cookie }
    );
    expect(res.status).toBe(201);
    const created = notebookLink.parse(await res.json());
    expect(created.created_by?.id).toBe(userId);
    expect(created.created_by_token).toBeNull();
    expect(created.label).toBeNull();
    expect(created.display_name).toBe("example.com › session");
  });

  it("rejects a second link to the same page and names the first", async () => {
    await createRun("run-duplicate");
    const first = notebookLink.parse(
      await (
        await addLink("run-duplicate", {
          url: `https://www.notion.so/arcadia/Old-title-${NOTION_ID}`,
        })
      ).json()
    );
    const res = await addLink("run-duplicate", {
      url: `http://notion.so/arcadia/Renamed-page-${NOTION_ID}#results`,
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.details.link_id).toBe(first.id);
  });

  it("rejects links that aren't http or https, and multi-line labels", async () => {
    await createRun("run-invalid");
    for (const url of ["javascript:alert(1)", "ftp://example.com/x", "nope"]) {
      const res = await addLink("run-invalid", { url });
      expect(res.status).toBe(400);
    }
    const res = await addLink("run-invalid", {
      url: "https://example.com/a",
      label: "two\nlines",
    });
    expect(res.status).toBe(400);
  });

  it(`stops at ${NOTEBOOK_LINKS_PER_RUN_MAX} links per run`, async () => {
    await createRun("run-limit");
    for (let i = 0; i < NOTEBOOK_LINKS_PER_RUN_MAX; i += 1) {
      const res = await addLink("run-limit", {
        url: `https://example.com/eln/${i}`,
      });
      expect(res.status).toBe(201);
    }
    const res = await addLink("run-limit", {
      url: "https://example.com/eln/one-too-many",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.message).toMatch(/at most/);
  });

  it("edits a link: another token can change it, and null clears the label", async () => {
    await createRun("run-edit");
    const created = notebookLink.parse(
      await (
        await addLink("run-edit", {
          url: "https://example.com/eln/a",
          label: "First",
        })
      ).json()
    );
    const res = await api(`${linksPath("run-edit")}/${created.id}`, {
      method: "PATCH",
      token: otherToken,
      body: { url: "https://example.com/eln/b", label: null },
    });
    expect(res.status).toBe(200);
    const updated = notebookLink.parse(await res.json());
    expect(updated.url).toBe("https://example.com/eln/b");
    expect(updated.label).toBeNull();
    expect(updated.created_by_token?.id).toBe(tokenId);
    expect(updated.updated_by_token?.id).toBe(otherTokenId);
  });

  it("won't edit a link into a duplicate of another on the same run", async () => {
    await createRun("run-edit-clash");
    await addLink("run-edit-clash", { url: "https://example.com/eln/a" });
    const second = notebookLink.parse(
      await (
        await addLink("run-edit-clash", { url: "https://example.com/eln/b" })
      ).json()
    );
    const res = await api(`${linksPath("run-edit-clash")}/${second.id}`, {
      method: "PATCH",
      token,
      body: { url: "https://www.example.com/eln/a/" },
    });
    expect(res.status).toBe(409);
  });

  it("returns 404 for a link ID that isn't a UUID or isn't on this run", async () => {
    await createRun("run-wrong-link");
    await createRun("run-other-link");
    const other = notebookLink.parse(
      await (
        await addLink("run-other-link", { url: "https://example.com/other" })
      ).json()
    );
    const notUuid = await api(`${linksPath("run-wrong-link")}/not-a-uuid`, {
      method: "PATCH",
      token,
      body: { label: "x" },
    });
    expect(notUuid.status).toBe(404);
    const foreign = await api(`${linksPath("run-wrong-link")}/${other.id}`, {
      method: "DELETE",
      token,
    });
    expect(foreign.status).toBe(404);
  });

  it("removes a link, and a second remove returns 404", async () => {
    await createRun("run-remove");
    const created = notebookLink.parse(
      await (
        await addLink("run-remove", { url: "https://example.com/eln/x" })
      ).json()
    );
    const first = await api(`${linksPath("run-remove")}/${created.id}`, {
      method: "DELETE",
      token,
    });
    expect(first.status).toBe(200);
    expect(notebookLinkDeleted.parse(await first.json()).id).toBe(created.id);

    const second = await api(`${linksPath("run-remove")}/${created.id}`, {
      method: "DELETE",
      token,
    });
    expect(second.status).toBe(404);
  });

  it("keeps a deleted run's links readable but refuses changes", async () => {
    await createRun("run-deleted");
    const created = notebookLink.parse(
      await (
        await addLink("run-deleted", { url: "https://example.com/eln/kept" })
      ).json()
    );
    await deleteRun("run-deleted");

    const add = await addLink("run-deleted", {
      url: "https://example.com/eln/new",
    });
    expect(add.status).toBe(409);
    const edit = await api(`${linksPath("run-deleted")}/${created.id}`, {
      method: "PATCH",
      token,
      body: { label: "x" },
    });
    expect(edit.status).toBe(409);
    const remove = await api(`${linksPath("run-deleted")}/${created.id}`, {
      method: "DELETE",
      token,
    });
    expect(remove.status).toBe(409);

    const list = await api(linksPath("run-deleted"), { token });
    const listed = notebookLinksListResponse.parse(await list.json());
    expect(listed.notebook_links).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Many runs at once
  // -------------------------------------------------------------------------

  it("bulk adds across instruments and reports each run's outcome", async () => {
    await createRun("bulk-new");
    await createRun("bulk-has-it");
    await createRun("bulk-deleted");
    await createRun("bulk-other", otherInstrumentId);
    const url = "https://benchling.example.com/entries/etr_12-gel-ladder";
    await addLink("bulk-has-it", { url: `${url}/`, label: "Kept label" });
    await deleteRun("bulk-deleted");

    const res = await api("/api/v1/instrument-runs/notebook-links", {
      method: "POST",
      token,
      body: {
        runs: [
          { instrument_id: instrumentId, run_id: "bulk-new" },
          { instrument_id: instrumentId, run_id: "bulk-has-it" },
          { instrument_id: instrumentId, run_id: "bulk-deleted" },
          { instrument_id: instrumentId, run_id: "bulk-missing" },
          { instrument_id: otherInstrumentId, run_id: "bulk-other" },
        ],
        url,
        label: "Gel ladder",
      },
    });
    expect(res.status).toBe(200);
    const body = bulkAddNotebookLinkResult.parse(await res.json());
    expect(body.results.map((r) => [r.run_id, r.outcome])).toEqual([
      ["bulk-new", "added"],
      ["bulk-has-it", "already_linked"],
      ["bulk-deleted", "run_deleted"],
      ["bulk-missing", "not_found"],
      ["bulk-other", "added"],
    ]);
    expect(body.counts).toEqual({
      added: 2,
      already_linked: 1,
      run_deleted: 1,
      limit_reached: 0,
      not_found: 1,
    });
    // The run that already linked to the page keeps its own label.
    expect(body.results[1].link?.label).toBe("Kept label");
    expect(body.results[0].link?.label).toBe("Gel ladder");
  });

  it("bulk add reports runs that are full", async () => {
    // `run-limit` already holds the most links allowed.
    const res = await api("/api/v1/instrument-runs/notebook-links", {
      method: "POST",
      token,
      body: {
        runs: [{ instrument_id: instrumentId, run_id: "run-limit" }],
        url: "https://example.com/eln/bulk-extra",
      },
    });
    const body = bulkAddNotebookLinkResult.parse(await res.json());
    expect(body.results[0].outcome).toBe("limit_reached");
  });

  it("bulk add refuses more than 100 runs", async () => {
    const runs = Array.from({ length: 101 }, (_, i) => ({
      instrument_id: instrumentId,
      run_id: `r-${i}`,
    }));
    const res = await api("/api/v1/instrument-runs/notebook-links", {
      method: "POST",
      token,
      body: { runs, url: "https://example.com/a" },
    });
    expect(res.status).toBe(400);
  });

  it("bulk removes links to the same page, even from a different copy of the URL", async () => {
    await createRun("bulk-rm-a");
    await createRun("bulk-rm-b");
    await addLink("bulk-rm-a", { url: "https://example.com/eln/shared" });
    await addLink("bulk-rm-a", { url: "https://example.com/eln/keep" });
    await addLink("bulk-rm-b", { url: "https://example.com/eln/keep" });

    const res = await api("/api/v1/instrument-runs/notebook-links/remove", {
      method: "POST",
      token,
      body: {
        runs: [
          { instrument_id: instrumentId, run_id: "bulk-rm-a" },
          { instrument_id: instrumentId, run_id: "bulk-rm-b" },
        ],
        urls: ["http://www.example.com/eln/shared/?utm_source=slack"],
      },
    });
    expect(res.status).toBe(200);
    const body = bulkRemoveNotebookLinksResult.parse(await res.json());
    expect(body.results.map((r) => [r.run_id, r.outcome, r.removed])).toEqual([
      ["bulk-rm-a", "removed", 1],
      ["bulk-rm-b", "not_linked", 0],
    ]);

    const list = await api(linksPath("bulk-rm-a"), { token });
    const listed = notebookLinksListResponse.parse(await list.json());
    expect(listed.notebook_links.map((link) => link.url)).toEqual([
      "https://example.com/eln/keep",
    ]);
  });

  // -------------------------------------------------------------------------
  // Reading links back: run detail, run lists, global search
  // -------------------------------------------------------------------------

  it("includes links in run detail", async () => {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs/run-add`, {
      token,
    });
    const detail = runDetail.parse(await res.json());
    expect(detail.notebook_links.map((link) => link.label)).toEqual([
      "Day 1 heat stress",
    ]);
  });

  it("filters run lists by whether a run has a link", async () => {
    const listInstrument = "notebook-links-filter";
    await getTestDb()
      .insert(instruments)
      .values({ id: listInstrument, displayName: "Filter", status: "active" });
    for (const runId of ["filter-linked", "filter-bare-1", "filter-bare-2"]) {
      await createRun(runId, listInstrument);
    }
    await api(linksPath("filter-linked", listInstrument), {
      method: "POST",
      token,
      body: { url: "https://example.com/eln/filter" },
    });

    const base = `/api/v1/instruments/${listInstrument}/runs`;
    const linked = runListResponse.parse(
      await (await api(`${base}?has_notebook_link=true`, { token })).json()
    );
    expect(linked.data.map((run) => run.run_id)).toEqual(["filter-linked"]);
    expect(linked.pagination.total).toBe(1);
    expect(linked.data[0].notebook_links).toHaveLength(1);

    const bare = runListResponse.parse(
      await (await api(`${base}?has_notebook_link=false`, { token })).json()
    );
    expect(bare.data.map((run) => run.run_id).sort()).toEqual([
      "filter-bare-1",
      "filter-bare-2",
    ]);
    expect(bare.pagination.total).toBe(2);

    const crossInstrument = runListResponse.parse(
      await (
        await api(
          `/api/v1/instrument-runs?instrument_id=${listInstrument}&has_notebook_link=true`,
          { token }
        )
      ).json()
    );
    expect(crossInstrument.pagination.total).toBe(1);
  });

  it("finds runs in global search by a pasted copy of a link's URL", async () => {
    await createRun("search-linked");
    await addLink("search-linked", {
      url: `https://www.notion.so/arcadia/Osmotic-stress-${NOTION_ID}`,
    });
    const params = new URLSearchParams({
      q: `http://notion.so/Renamed-page-${NOTION_ID}/?pvs=4#top`,
      scope: "runs",
    });
    const res = await api(`/api/v1/search?${params}`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as GlobalSearchResult;
    const hit = body.runs.find((run) => run.runId === "search-linked");
    expect(hit?.matchReason).toBe("notebook_link");
    expect(hit?.matchedNotebookLink?.displayName).toBe(
      "notion.so › Osmotic stress"
    );
  });

  it("finds runs in global search by a link's label", async () => {
    await createRun("search-label");
    await addLink("search-label", {
      url: "https://example.com/eln/label-search",
      label: "Cardamom pilot",
    });
    const params = new URLSearchParams({ q: "cardamom", scope: "runs" });
    const body = (await (
      await api(`/api/v1/search?${params}`, { token })
    ).json()) as GlobalSearchResult;
    expect(body.runs.map((run) => run.runId)).toContain("search-label");
  });

  it("bumps the run's updated time on each change, but not on a rejected duplicate", async () => {
    await createRun("run-touch");
    async function updatedAt(): Promise<string> {
      const res = await api(
        `/api/v1/instruments/${instrumentId}/runs/run-touch`,
        { token }
      );
      return (await res.json()).updated_at;
    }

    const before = await updatedAt();
    const created = notebookLink.parse(
      await (
        await addLink("run-touch", { url: "https://example.com/eln/touch" })
      ).json()
    );
    const afterAdd = await updatedAt();
    expect(afterAdd > before).toBe(true);

    const duplicate = await addLink("run-touch", {
      url: "https://www.example.com/eln/touch/",
    });
    expect(duplicate.status).toBe(409);
    expect(await updatedAt()).toBe(afterAdd);

    await api(`${linksPath("run-touch")}/${created.id}`, {
      method: "PATCH",
      token,
      body: { label: "Touched" },
    });
    const afterEdit = await updatedAt();
    expect(afterEdit > afterAdd).toBe(true);

    await api(`${linksPath("run-touch")}/${created.id}`, {
      method: "DELETE",
      token,
    });
    expect((await updatedAt()) > afterEdit).toBe(true);
  });
});
