import { readFileSync } from "node:fs";
import path from "node:path";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  notebooks,
  personalAccessTokens,
  runNotebookLinks,
} from "@/lib/db/schema";
import { notebookNameFromUrl } from "@/lib/notebook-links/url";
import {
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// Migration 0072 turns per-run link rows into one notebook per page. The test
// database is built from the current schema, so this test puts back the old
// `run_notebook_links` table from migration 0065, fills it, and runs 0072 on
// it. The migration leaves the tables in the shape the schema describes, so
// later test files see the usual schema.

const DRIZZLE = path.resolve(import.meta.dirname, "../../drizzle");

function statements(file: string): string[] {
  return readFileSync(path.join(DRIZZLE, file), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

const PAGE_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAGE_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const PAGE_C = "cccccccccccccccccccccccccccccccc";
const NOTION_NO_TITLE = `https://app.notion.com/p/${PAGE_B}`;
const ELN = "https://www.eln.example.com/s/etr-ab12/edit";
const DOC = "https://docs.example.com/document/d/Heat%20stress%20day%201";

describe("migration 0072_lab_notebooks", () => {
  let scriptTokenId = "";
  let readerTokenId = "";

  beforeAll(async () => {
    await resetDb();
    const db = getTestDb();
    const script = await seedTestUser({
      scopes: ["runs:read", "runs:link"],
      email: "script@example.com",
    });
    scriptTokenId = script.tokenId;
    const reader = await seedTestUser({
      scopes: ["runs:read"],
      email: "reader@example.com",
    });
    readerTokenId = reader.tokenId;

    await db.execute(
      sql.raw("DROP TABLE run_notebook_links, notebooks CASCADE")
    );
    for (const statement of statements("0065_lab_notebook_links.sql")) {
      await db.execute(sql.raw(statement));
    }

    await db.execute(sql`
      INSERT INTO "user" (id, name, email) VALUES
        ('alice', 'Alice', 'alice@example.com'),
        ('bob', 'Bob', 'bob@example.com'),
        ('carol', 'Carol', 'carol@example.com')`);
    await db.execute(sql`
      INSERT INTO instruments (id, display_name) VALUES
        ('mig-a', 'Instrument A'), ('mig-b', 'Instrument B')`);
    await db.execute(sql`
      INSERT INTO instrument_runs (id, instrument_id, run_id, acquired_at, deleted_at) VALUES
        ('10000000-0000-0000-0000-000000000001', 'mig-a', 'r1', '2026-01-01T00:00:00Z', NULL),
        ('10000000-0000-0000-0000-000000000002', 'mig-a', 'r2', '2026-01-02T00:00:00Z', NULL),
        ('10000000-0000-0000-0000-000000000003', 'mig-a', 'r3', '2026-01-03T00:00:00Z', NULL),
        ('10000000-0000-0000-0000-000000000004', 'mig-b', 'r4', '2026-01-04T00:00:00Z', NULL),
        ('10000000-0000-0000-0000-000000000005', 'mig-b', 'r5', '2026-01-05T00:00:00Z', NULL),
        ('10000000-0000-0000-0000-000000000006', 'mig-b', 'r6', '2026-01-06T00:00:00Z', '2026-02-01T00:00:00Z')`);
    await db.execute(sql`
      INSERT INTO run_attributions (run_id, user_id) VALUES
        ('10000000-0000-0000-0000-000000000001', 'alice'),
        ('10000000-0000-0000-0000-000000000002', 'alice'),
        ('10000000-0000-0000-0000-000000000002', 'bob'),
        ('10000000-0000-0000-0000-000000000003', 'bob'),
        ('10000000-0000-0000-0000-000000000004', 'bob'),
        ('10000000-0000-0000-0000-000000000005', 'carol'),
        ('10000000-0000-0000-0000-000000000006', 'carol')`);

    const reseedA = `https://app.notion.com/p/Reseed-${PAGE_A}`;
    const reseedV2A = `https://app.notion.com/p/Reseed-v2-${PAGE_A}`;
    const tieC = `https://app.notion.com/p/Tie-${PAGE_C}`;
    await db.execute(sql`
      INSERT INTO run_notebook_links
        (run_id, url, url_key, label, created_at, created_by, created_by_token, updated_at, updated_by, updated_by_token)
      VALUES
        ('10000000-0000-0000-0000-000000000001', ${reseedA}, ${`notion:${PAGE_A}`}, 'Reseed', '2026-01-10T00:00:00Z', 'alice', NULL, '2026-01-10T00:00:00Z', 'alice', NULL),
        ('10000000-0000-0000-0000-000000000002', ${reseedA}, ${`notion:${PAGE_A}`}, 'Reseed', '2026-01-11T00:00:00Z', 'bob', NULL, '2026-01-11T00:00:00Z', 'bob', NULL),
        ('10000000-0000-0000-0000-000000000003', ${reseedV2A}, ${`notion:${PAGE_A}`}, 'Reseed v2', '2026-01-12T00:00:00Z', 'bob', NULL, '2026-01-12T00:00:00Z', 'bob', NULL),
        ('10000000-0000-0000-0000-000000000004', ${reseedV2A}, ${`notion:${PAGE_A}`}, 'Reseed v2', '2026-01-13T00:00:00Z', 'bob', NULL, '2026-01-20T00:00:00Z', 'alice', NULL),
        ('10000000-0000-0000-0000-000000000005', ${ELN}, 'eln.example.com/s/etr-ab12/edit', NULL, '2026-01-10T00:00:00Z', 'carol', NULL, '2026-01-10T00:00:00Z', 'carol', NULL),
        ('10000000-0000-0000-0000-000000000006', ${ELN}, 'eln.example.com/s/etr-ab12/edit', NULL, '2026-01-11T00:00:00Z', 'carol', NULL, '2026-01-11T00:00:00Z', 'carol', NULL),
        ('10000000-0000-0000-0000-000000000001', ${NOTION_NO_TITLE}, ${`notion:${PAGE_B}`}, NULL, '2026-01-10T00:00:00Z', NULL, ${scriptTokenId}, '2026-01-10T00:00:00Z', NULL, ${scriptTokenId}),
        ('10000000-0000-0000-0000-000000000006', ${DOC}, 'docs.example.com/document/d/Heat%20stress%20day%201', NULL, '2026-01-10T00:00:00Z', 'alice', NULL, '2026-01-10T00:00:00Z', 'alice', NULL),
        ('10000000-0000-0000-0000-000000000001', ${tieC}, ${`notion:${PAGE_C}`}, 'Tie', '2026-01-10T00:00:00Z', 'alice', NULL, '2026-01-10T00:00:00Z', 'alice', NULL),
        ('10000000-0000-0000-0000-000000000004', ${tieC}, ${`notion:${PAGE_C}`}, 'Tie', '2026-01-11T00:00:00Z', 'bob', NULL, '2026-01-11T00:00:00Z', 'bob', NULL)`);

    // drizzle-kit applies a migration on one connection, which the
    // migration's temporary functions need. A transaction does the same here.
    await db.transaction(async (tx) => {
      for (const statement of statements("0072_lab_notebooks.sql")) {
        await tx.execute(sql.raw(statement));
      }
    });
  });

  afterAll(async () => {
    await resetDb();
    await closeTestDb();
  });

  async function notebookFor(urlKey: string) {
    const [row] = await getTestDb()
      .select()
      .from(notebooks)
      .where(eq(notebooks.urlKey, urlKey));
    return row;
  }

  it("makes one notebook per page and points every link at it", async () => {
    const rows = await getTestDb()
      .select({ urlKey: notebooks.urlKey })
      .from(notebooks)
      .orderBy(asc(notebooks.urlKey));
    expect(rows.map((row) => row.urlKey)).toEqual([
      "docs.example.com/document/d/Heat%20stress%20day%201",
      "eln.example.com/s/etr-ab12/edit",
      `notion:${PAGE_A}`,
      `notion:${PAGE_B}`,
      `notion:${PAGE_C}`,
    ]);
    const links = await getTestDb()
      .select({ notebookId: runNotebookLinks.notebookId })
      .from(runNotebookLinks);
    expect(links).toHaveLength(10);
    const pageA = await notebookFor(`notion:${PAGE_A}`);
    expect(links.filter((link) => link.notebookId === pageA.id)).toHaveLength(
      4
    );
  });

  it("names a page after its most-used label, the newest on a tie", async () => {
    const pageA = await notebookFor(`notion:${PAGE_A}`);
    expect(pageA.name).toBe("Reseed v2");
    expect(pageA.url).toBe(`https://app.notion.com/p/Reseed-v2-${PAGE_A}`);
  });

  it("names an unlabeled page after the page name in its link", async () => {
    for (const url of [ELN, NOTION_NO_TITLE, DOC]) {
      const [row] = await getTestDb()
        .select({ name: notebooks.name })
        .from(notebooks)
        .where(eq(notebooks.url, url));
      expect(row.name).toBe(notebookNameFromUrl(url));
    }
    expect(notebookNameFromUrl(DOC)).toBe("Heat stress day 1");
    expect(notebookNameFromUrl(NOTION_NO_TITLE)).toBe("app.notion.com");
  });

  it("records the earliest link's author and the latest change", async () => {
    const pageA = await notebookFor(`notion:${PAGE_A}`);
    expect(pageA.createdBy).toBe("alice");
    expect(pageA.createdAt.toISOString()).toBe("2026-01-10T00:00:00.000Z");
    expect(pageA.updatedBy).toBe("alice");
    expect(pageA.updatedAt.toISOString()).toBe("2026-01-20T00:00:00.000Z");
    const pageB = await notebookFor(`notion:${PAGE_B}`);
    expect(pageB.createdBy).toBeNull();
    expect(pageB.createdByToken).toBe(scriptTokenId);
  });

  it("makes the person who ran the most live runs the owner", async () => {
    // Bob ran three of the page's runs and Alice two.
    expect((await notebookFor(`notion:${PAGE_A}`)).ownerId).toBe("bob");
    // Carol's other run is deleted, but she ran the live one.
    expect((await notebookFor("eln.example.com/s/etr-ab12/edit")).ownerId).toBe(
      "carol"
    );
    // A token linked it; Alice ran its only run.
    expect((await notebookFor(`notion:${PAGE_B}`)).ownerId).toBe("alice");
  });

  it("breaks an owner tie by the most recent run", async () => {
    // Alice and Bob each ran one run; Bob's started later.
    expect((await notebookFor(`notion:${PAGE_C}`)).ownerId).toBe("bob");
  });

  it("leaves the owner empty when no live run has an attribution", async () => {
    const doc = await notebookFor(
      "docs.example.com/document/d/Heat%20stress%20day%201"
    );
    expect(doc.ownerId).toBeNull();
  });

  it("renames runs:link to notebooks:write on stored tokens", async () => {
    const tokens = await getTestDb()
      .select({
        id: personalAccessTokens.id,
        scopes: personalAccessTokens.scopes,
      })
      .from(personalAccessTokens);
    const byId = new Map(tokens.map((token) => [token.id, token.scopes]));
    expect(byId.get(scriptTokenId)).toEqual(["notebooks:write", "runs:read"]);
    expect(byId.get(readerTokenId)).toEqual(["runs:read"]);
  });
});
