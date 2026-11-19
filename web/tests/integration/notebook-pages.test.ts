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
    deletedId = await createNotebook({
      url: notionUrl("Old-pilot", 3),
      name: DELETED_NAME,
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
      // The runs table, across instruments.
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
});
