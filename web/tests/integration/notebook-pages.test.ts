import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instruments } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedSessionCookie,
  seedTestUser,
} from "@/tests/integration/helpers";

// Renders the lab notebook pages against the production build, so a server
// component that throws fails here instead of showing "This page couldn't
// load", and an unknown notebook is a real 404 (sent before any streaming
// starts). The notebooks API itself is covered in `notebooks.test.ts`.

const INSTRUMENT = "notebook-pages-reader";
const RUN_ID = "NBP-RUN-1";

const LIVE_NAME = "Growth curves week 3";
const LIVE_DESCRIPTION = "Plate reader runs for the synthetic growth study.";
const DELETED_NAME = "Retired pilot notebook";
const EMPTY_NAME = "Empty scratch notebook";

// Synthetic Notion page IDs: 32 hex digits, the last two from `n`.
function notionUrl(title: string, n: number): string {
  const id = `5b1d7c02a9e34f6b8d0c1e2f3a4b5c${n.toString(16).padStart(2, "0")}`;
  return `https://www.notion.so/lab/${title}-${id}`;
}

// A table row's icon link to the notebook's own page. The sidebar lists a
// notebook that got a run by name too, but without this link, so it tells
// the table's rows apart from the sidebar's.
function rowLink(name: string): string {
  return `aria-label="Open ${name} in a new tab"`;
}

// React's server render puts `<!-- -->` between adjacent text parts.
function textOf(html: string): string {
  return html.replaceAll("<!-- -->", "");
}

function expectRendered(html: string) {
  // The root error screen, and the load error boundary's own message.
  expect(html).not.toContain("This page couldn’t load");
  expect(html).not.toContain("Couldn’t load this.");
}

describe("Lab notebook pages", () => {
  let cookie: string;
  let userId: string;
  let liveId: string;
  let deletedId: string;
  let emptyId: string;

  function page(path: string, withCookie = true) {
    return api(path, {
      headers: {
        Accept: "text/html",
        ...(withCookie ? { Cookie: cookie } : {}),
      },
      redirect: "manual",
    });
  }

  async function createNotebook(body: Record<string, unknown>) {
    const res = await api("/api/v1/lab-notebooks", {
      method: "POST",
      headers: { Cookie: cookie },
      body,
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { lab_notebook: { id: string } };
    return created.lab_notebook.id;
  }

  beforeAll(async () => {
    await resetDb();
    const user = await seedTestUser({
      name: "Nora Notebook",
      email: "nora@notebook-pages.test",
      tokenName: "Notebook Pages Bot",
    });
    userId = user.userId;
    cookie = await seedSessionCookie(user.userId);

    await getTestDb().insert(instruments).values({
      id: INSTRUMENT,
      displayName: "Notebook Pages Reader",
      status: "active",
    });
    const run = await api(`/api/v1/instruments/${INSTRUMENT}/runs`, {
      method: "POST",
      token: user.token,
      body: { run_id: RUN_ID, source: "lambda" },
    });
    expect(run.status).toBe(201);

    liveId = await createNotebook({
      url: notionUrl("Growth-curves", 1),
      name: LIVE_NAME,
      description: LIVE_DESCRIPTION,
      owner_id: "me",
      runs: [{ instrument_id: INSTRUMENT, run_id: RUN_ID }],
    });
    emptyId = await createNotebook({
      url: notionUrl("Scratch", 2),
      name: EMPTY_NAME,
    });
    // Owned, so a member's page has a deleted lab notebook to leave out.
    deletedId = await createNotebook({
      url: notionUrl("Old-pilot", 3),
      name: DELETED_NAME,
      owner_id: "me",
    });
    const deleted = await api(`/api/v1/lab-notebooks/${deletedId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(deleted.status).toBe(200);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  describe("/lab-notebooks", () => {
    it("lists live lab notebooks and leaves deleted ones out", async () => {
      const res = await page("/lab-notebooks");
      const html = await res.text();
      expect(res.status).toBe(200);
      expectRendered(html);
      expect(html).toContain("<title>Lab Notebooks | Data Hub</title>");
      expect(html).toContain("New lab notebook");
      expect(html).toContain(rowLink(LIVE_NAME));
      expect(html).toContain(rowLink(EMPTY_NAME));
      expect(html).toContain(`href="/lab-notebooks/${emptyId}"`);
      expect(html).not.toContain(DELETED_NAME);
    });

    it("shows deleted lab notebooks when asked", async () => {
      const res = await page("/lab-notebooks?include_deleted=true");
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain(rowLink(DELETED_NAME));
      expect(html).toContain(rowLink(LIVE_NAME));
    });

    it("finds a lab notebook by a pasted link, and only that one", async () => {
      const q = encodeURIComponent(`${notionUrl("Renamed-title", 1)}?pvs=4`);
      const res = await page(`/lab-notebooks?q=${q}`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain(rowLink(LIVE_NAME));
      expect(html).not.toContain(EMPTY_NAME);
    });

    it("says when nothing matches", async () => {
      const res = await page("/lab-notebooks?q=no-such-notebook-text");
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain("No lab notebooks match your search.");
      expect(html).not.toContain(rowLink(LIVE_NAME));
    });
  });

  describe("lab notebooks on Home and profiles", () => {
    it("lists the lab notebooks a person owns on their page, under the runs", async () => {
      const res = await page(`/users/${userId}`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expectRendered(html);
      expect(html).toContain(">Instrument runs</h2>");
      expect(html).toContain(">Lab notebooks</h2>");
      expect(html).toContain(">Comments</h2>");
      expect(html).not.toContain(">Recent instrument runs</h2>");
      expect(html).not.toContain(">Recent comments</h2>");
      // The runs come first, then the lab notebooks, then the comments.
      const runsAt = html.indexOf(">Instrument runs</h2>");
      const notebooksAt = html.indexOf(">Lab notebooks</h2>");
      const commentsAt = html.indexOf(">Comments</h2>");
      expect(runsAt).toBeLessThan(notebooksAt);
      expect(notebooksAt).toBeLessThan(commentsAt);
      // Only the ones this person owns: not an unowned or a deleted one.
      expect(html).toContain(rowLink(LIVE_NAME));
      expect(html).not.toContain(rowLink(EMPTY_NAME));
      expect(html).not.toContain(DELETED_NAME);
    });

    it("counts a person's lab notebooks that got a run this week, in place of runs today", async () => {
      // Nora owns one live lab notebook, which got today's run, and one deleted
      // one, which doesn't count.
      const html = textOf(await (await page(`/users/${userId}`)).text());
      expect(html).toMatch(
        />Lab notebooks this week<\/p><p[^>]*>1<\/p><p[^>]*>of 1 owned<\/p>/
      );
      expect(html).not.toContain(">Runs today</p>");
      // Runs this week comes first, then the lab notebooks.
      expect(html.indexOf(">Runs this week</p>")).toBeLessThan(
        html.indexOf(">Lab notebooks this week</p>")
      );
    });

    // No run matches the search, so the runs table's Lab Notebook column
    // can't stand in for a row. The lab notebooks list ignores it.
    const NO_RUNS = "search=no-run-has-this-name";

    it("lists the lab notebooks that got a run today on Home", async () => {
      const res = await page(`/?${NO_RUNS}`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expectRendered(html);
      expect(html).toContain(">Instrument runs</h2>");
      expect(html).toContain(">Lab notebooks</h2>");
      expect(html).toContain(">Comments</h2>");
      expect(html).not.toContain(">Recent instrument runs</h2>");
      expect(html).not.toContain(">Recent comments</h2>");
      expect(html).toContain(rowLink(LIVE_NAME));
      expect(html).not.toContain(rowLink(EMPTY_NAME));
      expect(html).not.toContain(DELETED_NAME);
      expect(textOf(html)).toMatch(
        /Showing <span[^>]*>1<\/span> of <span[^>]*>1<\/span>/
      );
    });

    it("lists every live lab notebook on Home for all time", async () => {
      const html = await (await page(`/?${NO_RUNS}&notebooks_from=all`)).text();
      expect(html).toContain(rowLink(LIVE_NAME));
      expect(html).toContain(rowLink(EMPTY_NAME));
      expect(html).not.toContain(DELETED_NAME);
    });

    it("leaves out lab notebooks with no run in the picked range", async () => {
      const html = await (
        await page(
          `/?${NO_RUNS}&notebooks_from=2000-01-01T00:00:00.000Z&notebooks_to=2000-01-02T00:00:00.000Z`
        )
      ).text();
      expect(html).not.toContain(rowLink(LIVE_NAME));
      expect(html).toContain("No lab notebooks match these filters.");
    });

    it("searches Home's lab notebooks from the Name header", async () => {
      const html = await (
        await page(`/?${NO_RUNS}&notebooks_from=all&notebooks_q=scratch`)
      ).text();
      expect(html).toMatch(/>Name<\/button>/);
      expect(html).toContain(rowLink(EMPTY_NAME));
      expect(html).not.toContain(rowLink(LIVE_NAME));
    });

    it("filters Home's lab notebooks by owner, or to the ones with none", async () => {
      const mine = await (
        await page(`/?${NO_RUNS}&notebooks_from=all&notebooks_owner=${userId}`)
      ).text();
      expect(mine).toContain(rowLink(LIVE_NAME));
      expect(mine).not.toContain(rowLink(EMPTY_NAME));

      const unowned = await (
        await page(`/?${NO_RUNS}&notebooks_from=all&notebooks_owner=none`)
      ).text();
      expect(unowned).toContain(rowLink(EMPTY_NAME));
      expect(unowned).not.toContain(rowLink(LIVE_NAME));
    });

    it("filters by Owner on Home, and leaves the column off a person's own list", async () => {
      // On Home the header is the Owner filter's menu button.
      const home = await (await page("/")).text();
      expect(home).toMatch(/>Owner<\/button>/);
      const profile = await (await page(`/users/${userId}`)).text();
      expect(profile).not.toMatch(/>Owner<\/(th|button)>/);
    });

    it("filters runs from the Run ID and Instrument headers, not a toolbar search", async () => {
      // Today's run fills the runs table, so its headers render.
      const html = await (await page("/")).text();
      expect(html).toMatch(/>Run ID<\/button>/);
      expect(html).toMatch(/>Instrument<\/button>/);
      expect(html).not.toContain('aria-label="Search runs"');
    });

    it("calls the sidebar link to a person's page My activity", async () => {
      const res = await page("/");
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain(`href="/users/${userId}"`);
      expect(html).toContain("<span>My activity</span>");
    });
  });

  describe("the sidebar's Instruments and Lab Notebooks groups", () => {
    function pageWith(path: string, groupCookie?: string) {
      return api(path, {
        headers: {
          Accept: "text/html",
          Cookie: groupCookie ? `${cookie}; ${groupCookie}` : cookie,
        },
        redirect: "manual",
      });
    }

    it("render open without a cookie, and closed when their cookie says false", async () => {
      // A group's links are only rendered while it is open.
      const instrumentLink = `href="/instruments/${INSTRUMENT}"`;
      const notebookLink = `href="/lab-notebooks/${liveId}"`;

      const fresh = await (await pageWith("/lab-notebooks")).text();
      expect(fresh).toContain(instrumentLink);
      const freshInstruments = await (await pageWith("/instruments")).text();
      expect(freshInstruments).toContain(notebookLink);

      const instrumentsClosed = await (
        await pageWith("/lab-notebooks", "sidebar_instruments_state=false")
      ).text();
      expect(instrumentsClosed).not.toContain(instrumentLink);
      // Each group has its own cookie, so the other one stays open.
      const onlyInstrumentsClosed = await (
        await pageWith("/instruments", "sidebar_instruments_state=false")
      ).text();
      expect(onlyInstrumentsClosed).toContain(notebookLink);

      const notebooksClosed = await (
        await pageWith("/instruments", "sidebar_notebooks_state=false")
      ).text();
      expect(notebooksClosed).not.toContain(notebookLink);
    });
  });

  describe("/lab-notebooks/:id", () => {
    it("shows the lab notebook, its owner and counts, and its runs", async () => {
      const res = await page(`/lab-notebooks/${liveId}`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expectRendered(html);
      expect(html).toContain(`<title>${LIVE_NAME} | Data Hub</title>`);
      expect(html).toContain(LIVE_DESCRIPTION);
      expect(html).toContain("Open lab notebook");
      expect(html).toContain('aria-label="Lab notebook actions"');
      const text = textOf(html);
      expect(text).toContain("1 run");
      expect(text).toContain("1 instrument");
      expect(html).toContain("Nora Notebook");
      // The runs table, across instruments, under its own heading.
      expect(html).toContain(">Instrument runs</h2>");
      expect(html).toContain(RUN_ID);
      expect(html).toContain("Notebook Pages Reader");
      // A live notebook has no deleted banner.
      expect(text).not.toContain("until it’s restored");
    });

    it("says an empty lab notebook has no runs yet", async () => {
      const res = await page(`/lab-notebooks/${emptyId}`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain(EMPTY_NAME);
      expect(html).toContain("No runs yet");
      expect(html).toContain("No runs in this lab notebook yet.");
    });

    it("shows a deleted lab notebook with who deleted it and a Restore button", async () => {
      const res = await page(`/lab-notebooks/${deletedId}`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expectRendered(html);
      expect(html).toContain(DELETED_NAME);
      const text = textOf(html);
      expect(text).toContain(
        "Runs don’t list this lab notebook until it’s restored."
      );
      expect(text).toMatch(/Deleted .*by/);
      expect(text).toMatch(/>Restore<\/button>/);
    });

    it("returns 404 for a lab notebook that doesn't exist", async () => {
      const unknown = await page(
        "/lab-notebooks/00000000-0000-4000-8000-000000000000"
      );
      expect(unknown.status).toBe(404);
      const garbage = await page("/lab-notebooks/not-a-uuid");
      expect(garbage.status).toBe(404);
    });

    it("unfurls for a signed-out visitor with the name but nothing else", async () => {
      const res = await page(`/lab-notebooks/${liveId}`, false);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain(`property="og:title" content="${LIVE_NAME}"`);
      expect(html).not.toContain(LIVE_DESCRIPTION);
      expect(html).not.toContain(RUN_ID);
    });
  });

  describe("links to lab notebook pages", () => {
    it("lists lab notebooks that got a run in the sidebar, but not deleted or empty ones", async () => {
      const res = await page("/instruments");
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain('href="/lab-notebooks"');
      expect(html).toContain(`href="/lab-notebooks/${liveId}"`);
      expect(html).not.toContain(`href="/lab-notebooks/${deletedId}"`);
      expect(html).not.toContain(`href="/lab-notebooks/${emptyId}"`);
    });

    it("links the Lab Notebook column to the lab notebook page, with the page itself a click away", async () => {
      const res = await page(`/instruments/${INSTRUMENT}`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain(`href="/lab-notebooks/${liveId}"`);
      expect(html).toContain(rowLink(LIVE_NAME));
    });

    it("links the run page's Lab Notebooks rows to the lab notebook page", async () => {
      const res = await page(`/instruments/${INSTRUMENT}/runs/${RUN_ID}`);
      const html = await res.text();
      expect(res.status).toBe(200);
      expectRendered(html);
      expect(html).toContain(`href="/lab-notebooks/${liveId}"`);
      expect(html).toContain(rowLink(LIVE_NAME));
    });
  });

  // Last, because it adds lab notebooks that the tests above don't expect.
  describe("paging a member's lab notebooks", () => {
    const pagingName = (n: number) => `Paging notebook ${n}`;

    beforeAll(async () => {
      // With the one that got a run, Nora owns six: five on the first page,
      // and the last of these by name on the second.
      for (let n = 1; n <= 5; n++) {
        await createNotebook({
          url: notionUrl(`Paging-${n}`, 10 + n),
          name: pagingName(n),
          owner_id: "me",
        });
      }
    });

    it("shows five at a time, paged by its own param", async () => {
      const first = await (await page(`/users/${userId}`)).text();
      expect(first).toContain(rowLink(LIVE_NAME));
      expect(first).toContain(rowLink(pagingName(4)));
      expect(first).not.toContain(rowLink(pagingName(5)));
      expect(textOf(first)).toMatch(
        /Showing <span[^>]*>5<\/span> of <span[^>]*>6<\/span>/
      );
      expect(first).toContain(`href="/users/${userId}?notebooks_page=2"`);

      const second = await (
        await page(`/users/${userId}?notebooks_page=2`)
      ).text();
      expect(second).toContain(rowLink(pagingName(5)));
      expect(second).not.toContain(rowLink(LIVE_NAME));
    });

    it("pages Home's lab notebooks the same way", async () => {
      // All time, so the ones without a run are listed: seven in all.
      const html = await (await page("/?notebooks_from=all")).text();
      expect(textOf(html)).toMatch(
        /Showing <span[^>]*>5<\/span> of <span[^>]*>7<\/span>/
      );
      expect(html).toContain(
        'href="/?notebooks_from=all&amp;notebooks_page=2"'
      );
    });

    it("stays on its own page when the runs table pages", async () => {
      const html = await (await page(`/users/${userId}?page=2`)).text();
      expect(html).toContain(rowLink(LIVE_NAME));
      expect(html).not.toContain(rowLink(pagingName(5)));
      // Its page links keep the runs table's page.
      expect(html).toContain(
        `href="/users/${userId}?page=2&amp;notebooks_page=2"`
      );
    });
  });
});
