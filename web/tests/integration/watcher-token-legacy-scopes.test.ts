import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { narrowWatcherTokenScopes } from "@/lib/api/watcher-binding";
import {
  files,
  instrumentRuns,
  instruments,
  personalAccessTokens,
  watchers,
} from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// Tokens minted before the fine-grained scope split can carry `*` or a coarse
// `:write` scope. On a token that registered a watcher, those count only for
// what a watcher needs, so a lab PC's old token can't read every instrument's
// runs and files. Other old tokens, such as the Lambda's, keep what they had.

const OWN = "legacy-own";
const OTHER = "legacy-other";
const GONE = "legacy-gone";
const COARSE = "legacy-coarse";
const RUN = "legacy-run";
const OTHER_RUN = `/api/v1/instruments/${OTHER}/runs/${RUN}`;

const MISSING_SCOPE = /^Token is missing required scope: /;

// Every route that reads runs or files, pointed at another instrument's run
// where it names one.
function readRoutes(fileId: number): { name: string; path: string }[] {
  return [
    { name: "list runs", path: `/api/v1/instruments/${OTHER}/runs` },
    { name: "list runs everywhere", path: "/api/v1/instrument-runs" },
    { name: "search", path: "/api/v1/search?q=legacy" },
    { name: "get a run", path: OTHER_RUN },
    { name: "list comments", path: `${OTHER_RUN}/comments` },
    { name: "list lab notebooks", path: "/api/v1/lab-notebooks" },
    { name: "list report items", path: `${OTHER_RUN}/report-items` },
    { name: "download the archive", path: `${OTHER_RUN}/download-archive` },
    { name: "download a file", path: `/api/v1/files/${fileId}/download` },
  ];
}

async function registerWatcher(token: string, instrumentId: string) {
  const res = await api("/api/v1/watchers/register", {
    method: "POST",
    token,
    body: { instrument_id: instrumentId, hostname: `pc-${instrumentId}` },
  });
  expect(res.status).toBe(201);
  return (await res.json()).watcher_id as string;
}

async function createRun(token: string, instrumentId: string) {
  const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
    method: "POST",
    token,
    body: {
      run_id: RUN,
      source: "watcher",
      detected_files: [
        { relative_path: "one.csv", filename: "one.csv", size_bytes: 1 },
      ],
    },
  });
  expect(res.status).toBe(201);
}

async function expectMissingScope(res: Response) {
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error.message).toMatch(MISSING_SCOPE);
}

// The route may still refuse for its own reasons, such as the archive builder
// not being set up in tests, but not for a missing scope.
async function expectScopeAccepted(res: Response) {
  if (res.status !== 403) {
    return;
  }
  const body = await res.json();
  expect(body.error.message).not.toMatch(MISSING_SCOPE);
}

afterAll(async () => {
  await closeTestDb();
});

describe("legacy scopes on a watcher's token", () => {
  let watcherToken: string;
  let watcherId: string;
  let deregisteredToken: string;
  let coarseToken: string;
  let unboundToken: string;
  let routes: { name: string; path: string }[];

  beforeAll(async () => {
    await resetDb();
    const db = getTestDb();
    await db.insert(instruments).values(
      [OWN, OTHER, GONE, COARSE].map((id) => ({
        id,
        displayName: id,
        status: "active" as const,
      }))
    );

    ({ token: watcherToken } = await seedTestUser({ scopes: ["*"] }));
    ({ token: deregisteredToken } = await seedTestUser({ scopes: ["*"] }));
    ({ token: unboundToken } = await seedTestUser({ scopes: ["*"] }));
    ({ token: coarseToken } = await seedTestUser({
      scopes: [
        "instruments:read",
        "watchers:read",
        "runs:write",
        "files:write",
        "watchers:write",
      ],
    }));

    watcherId = await registerWatcher(watcherToken, OWN);
    await registerWatcher(coarseToken, COARSE);
    const goneId = await registerWatcher(deregisteredToken, GONE);
    await db
      .update(watchers)
      .set({ deletedAt: new Date(), status: "stopped" })
      .where(eq(watchers.id, goneId));

    // A token that registered no watcher, like the Lambda's, writes the run
    // the other tokens try to read.
    await createRun(unboundToken, OTHER);
    await createRun(coarseToken, COARSE);

    const [file] = await db
      .select({ id: files.id })
      .from(files)
      .innerJoin(instrumentRuns, eq(instrumentRuns.id, files.instrumentRunId))
      .where(eq(instrumentRuns.instrumentId, OTHER));
    routes = readRoutes(file.id);
  });

  it("stops a watcher's `*` token reading runs and files", async () => {
    for (const route of routes) {
      await expectMissingScope(await api(route.path, { token: watcherToken }));
    }
  });

  it("stops it for a token whose watcher was deregistered", async () => {
    for (const route of routes) {
      await expectMissingScope(
        await api(route.path, { token: deregisteredToken })
      );
    }
  });

  it("still lets a watcher's `*` token do a watcher's work", async () => {
    const heartbeat = await api(`/api/v1/watchers/${watcherId}/heartbeat`, {
      method: "POST",
      token: watcherToken,
      body: { status: "watching" },
    });
    expect(heartbeat.status).toBe(200);

    await createRun(watcherToken, OWN);
    const uploadUrl = await api(
      `/api/v1/instruments/${OWN}/runs/${RUN}/request-upload-url`,
      {
        method: "POST",
        token: watcherToken,
        body: { filename: "one.csv", size_bytes: 1 },
      }
    );
    expect(uploadUrl.ok).toBe(true);

    expect(
      (await api("/api/v1/instruments", { token: watcherToken })).status
    ).toBe(200);
    expect(
      (await api(`/api/v1/watchers/${watcherId}`, { token: watcherToken }))
        .status
    ).toBe(200);
  });

  it("keeps only the watcher's part of a coarse :write scope", async () => {
    const run = `/api/v1/instruments/${COARSE}/runs/${RUN}`;
    expect(
      (
        await api(run, {
          method: "PATCH",
          token: coarseToken,
          body: { metadata: { checked: true } },
        })
      ).ok
    ).toBe(true);
    // `runs:write` used to imply `runs:reprocess`; a watcher never reprocesses.
    await expectMissingScope(
      await api(`${run}/reprocess`, { method: "POST", token: coarseToken })
    );
  });

  it("leaves a `*` token that registered no watcher as it was", async () => {
    for (const route of routes) {
      await expectScopeAccepted(await api(route.path, { token: unboundToken }));
    }
    expect((await api(OTHER_RUN, { token: unboundToken })).status).toBe(200);
  });
});

// The migration stores the same narrowing that `validatePat` applies.
describe("migration 0071_narrow_watcher_token_legacy_scopes", () => {
  const MIGRATION = path.resolve(
    import.meta.dirname,
    "../../drizzle/0071_narrow_watcher_token_legacy_scopes.sql"
  );

  interface Case {
    bound: "active" | "deregistered" | "none";
    name: string;
    narrowed: boolean;
    revoked?: boolean;
    scopes: string[];
  }

  const CASES: Case[] = [
    { name: "wildcard", scopes: ["*"], bound: "active", narrowed: true },
    {
      name: "coarse writes",
      scopes: ["instruments:read", "runs:write", "files:write"],
      bound: "active",
      narrowed: true,
    },
    {
      name: "explicit read kept",
      scopes: ["runs:read", "watchers:write"],
      bound: "active",
      narrowed: true,
    },
    {
      name: "deregistered watcher",
      scopes: ["*"],
      bound: "deregistered",
      narrowed: true,
    },
    { name: "no watcher", scopes: ["*"], bound: "none", narrowed: false },
    {
      name: "revoked",
      scopes: ["*"],
      bound: "active",
      revoked: true,
      narrowed: false,
    },
    {
      name: "fine-grained only",
      scopes: ["runs:read", "watchers:report"],
      bound: "active",
      narrowed: false,
    },
  ];

  const tokenIds = new Map<string, string>();

  beforeAll(async () => {
    await resetDb();
    const db = getTestDb();
    for (const [index, testCase] of CASES.entries()) {
      const { tokenId } = await seedTestUser({ scopes: testCase.scopes });
      tokenIds.set(testCase.name, tokenId);
      if (testCase.revoked) {
        await db
          .update(personalAccessTokens)
          .set({ revokedAt: new Date() })
          .where(eq(personalAccessTokens.id, tokenId));
      }
      if (testCase.bound === "none") {
        continue;
      }
      const instrumentId = `migration-${index}`;
      await db
        .insert(instruments)
        .values({ id: instrumentId, displayName: instrumentId });
      await db.insert(watchers).values({
        instrumentId,
        status: "registered",
        registeredByToken: tokenId,
        deletedAt: testCase.bound === "deregistered" ? new Date() : null,
      });
    }

    const statements = readFileSync(MIGRATION, "utf8")
      .split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    for (const statement of statements) {
      await db.execute(sql.raw(statement));
    }
  });

  it.each(CASES)("$name", async (testCase) => {
    const [row] = await getTestDb()
      .select({ scopes: personalAccessTokens.scopes })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.id, tokenIds.get(testCase.name) ?? ""));
    const expected = testCase.narrowed
      ? narrowWatcherTokenScopes(testCase.scopes)
      : testCase.scopes;
    expect([...row.scopes].sort()).toEqual([...expected].sort());
  });
});
