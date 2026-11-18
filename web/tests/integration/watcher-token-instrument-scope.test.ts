import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALL_SCOPES } from "@/lib/api/scopes";
import {
  archiveJobs,
  files,
  instrumentRuns,
  instruments,
  runComments,
  runNotebookLinks,
  watchers,
} from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedSessionCookie,
  seedTestUser,
} from "@/tests/integration/helpers";

// Every write route that names an instrument, run, file or archive job lets a
// watcher's token act only on its own instrument. The watcher tokens here
// carry every scope, like a deployed watcher token minted with the legacy `*`
// or `:write` scopes, so they reach routes the Watcher preset alone can't. A
// token that registered no watcher, such as the Lambda's, is not limited.

const A = "scope-instr-a";
const B = "scope-instr-b";
const RUN = "scope-run";
const RUN_PATH = `/api/v1/instruments/${A}/runs/${RUN}`;
const LINK_URL = "https://example.com/eln/scope-1";

interface Fixture {
  commentId: string;
  fileId: number;
  jobId: string;
  linkId: string;
  userId: string;
}

interface RouteCase {
  body?: (f: Fixture) => unknown;
  method: "POST" | "PATCH" | "DELETE";
  name: string;
  path: (f: Fixture) => string;
}

// The routes that undo or delete come last, so the earlier rows still exist
// when the instrument's own token runs through the table.
const ROUTES: RouteCase[] = [
  {
    name: "create a run",
    method: "POST",
    path: () => `/api/v1/instruments/${A}/runs`,
    body: () => ({ run_id: "scope-new-run", source: "watcher" }),
  },
  {
    name: "update a run",
    method: "PATCH",
    path: () => RUN_PATH,
    body: () => ({ metadata: { injected: true } }),
  },
  {
    name: "request uploads",
    method: "POST",
    path: () => `${RUN_PATH}/request-upload`,
    body: (f) => ({ file_ids: [f.fileId] }),
  },
  {
    name: "request every upload",
    method: "POST",
    path: () => `${RUN_PATH}/request-upload-all`,
  },
  {
    name: "get an upload link",
    method: "POST",
    path: () => `${RUN_PATH}/request-upload-url`,
    body: () => ({ filename: "one.csv", size_bytes: 1 }),
  },
  {
    name: "add a processed file",
    method: "POST",
    path: () => `${RUN_PATH}/files`,
    body: () => ({
      s3_bucket: "test-bucket",
      s3_key: `${A}/${RUN}/injected.csv`,
      filename: "injected.csv",
    }),
  },
  {
    name: "reprocess a run",
    method: "POST",
    path: () => `${RUN_PATH}/reprocess`,
  },
  {
    name: "cancel queued files",
    method: "POST",
    path: () => `${RUN_PATH}/cancel-queued`,
  },
  {
    name: "comment on a run",
    method: "POST",
    path: () => `${RUN_PATH}/comments`,
    body: () => ({ body: "injected" }),
  },
  {
    name: "edit a comment",
    method: "PATCH",
    path: (f) => `${RUN_PATH}/comments/${f.commentId}`,
    body: () => ({ body: "edited" }),
  },
  {
    name: "add a notebook link",
    method: "POST",
    path: () => `${RUN_PATH}/notebook-links`,
    body: () => ({ url: "https://example.com/eln/scope-2" }),
  },
  {
    name: "edit a notebook link",
    method: "PATCH",
    path: (f) => `${RUN_PATH}/notebook-links/${f.linkId}`,
    body: () => ({ label: "edited" }),
  },
  {
    name: "add notebook links in bulk",
    method: "POST",
    path: () => "/api/v1/instrument-runs/notebook-links",
    body: () => ({
      runs: [{ instrument_id: A, run_id: RUN }],
      url: "https://example.com/eln/scope-3",
    }),
  },
  {
    name: "send a notification about a run",
    method: "POST",
    path: () => "/api/v1/notifications/dispatch",
    body: (f) => ({
      user_ids: [f.userId],
      message: "injected",
      run: { instrument_id: A, run_id: RUN },
    }),
  },
  {
    name: "update an archive job",
    method: "PATCH",
    path: (f) => `/api/v1/archive-jobs/${f.jobId}`,
    body: () => ({ status: "failed", error_message: "injected" }),
  },
  {
    name: "update a file",
    method: "PATCH",
    path: (f) => `/api/v1/files/${f.fileId}`,
    body: () => ({ status: "upload_requested" }),
  },
  {
    name: "reprocess a file",
    method: "POST",
    path: (f) => `/api/v1/files/${f.fileId}/reprocess`,
  },
  {
    name: "sign multipart part URLs",
    method: "POST",
    path: (f) => `/api/v1/files/${f.fileId}/multipart-upload/part-urls`,
    body: () => ({ upload_id: "scope-upload", part_numbers: [1] }),
  },
  {
    name: "finish a multipart upload",
    method: "POST",
    path: (f) => `/api/v1/files/${f.fileId}/multipart-upload/complete`,
    body: () => ({
      upload_id: "scope-upload",
      checksum_crc64nvme: "AAAAAAAAAAA=",
      parts: [{ part_number: 1, etag: "etag" }],
    }),
  },
  {
    name: "cancel a multipart upload",
    method: "DELETE",
    path: (f) => `/api/v1/files/${f.fileId}/multipart-upload`,
    body: () => ({ upload_id: "scope-upload" }),
  },
  {
    name: "remove notebook links in bulk",
    method: "POST",
    path: () => "/api/v1/instrument-runs/notebook-links/remove",
    body: () => ({
      runs: [{ instrument_id: A, run_id: RUN }],
      urls: ["https://example.com/eln/scope-3"],
    }),
  },
  {
    name: "remove a notebook link",
    method: "DELETE",
    path: (f) => `${RUN_PATH}/notebook-links/${f.linkId}`,
  },
  {
    name: "delete a comment",
    method: "DELETE",
    path: (f) => `${RUN_PATH}/comments/${f.commentId}`,
  },
  {
    name: "dismiss a file",
    method: "DELETE",
    path: (f) => `/api/v1/files/${f.fileId}`,
  },
  {
    name: "delete a run",
    method: "DELETE",
    path: () => RUN_PATH,
  },
  {
    name: "restore a run",
    method: "POST",
    path: () => `${RUN_PATH}/restore`,
  },
];

// The 403 this change adds, told apart from a missing scope, which is also a
// 403.
const OWNERSHIP_REFUSAL =
  /not authorized for this (instrument|file's instrument)|can't change instruments/;

async function expectOwnershipRefusal(res: Response) {
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error.code).toBe("FORBIDDEN");
  expect(body.error.message).toMatch(OWNERSHIP_REFUSAL);
}

async function expectNotOwnershipRefusal(res: Response) {
  if (res.status !== 403) {
    return;
  }
  const body = await res.json();
  expect(body.error.message).not.toMatch(OWNERSHIP_REFUSAL);
}

function send(route: RouteCase, fixture: Fixture, token: string) {
  return api(route.path(fixture), {
    method: route.method,
    token,
    body: route.body?.(fixture),
  });
}

// Every row on instrument A that a route in the table could write.
async function snapshotInstrumentA() {
  const db = getTestDb();
  const runs = await db
    .select()
    .from(instrumentRuns)
    .where(eq(instrumentRuns.instrumentId, A))
    .orderBy(instrumentRuns.runId);
  const runIds = runs.map((run) => run.id);
  return {
    instrument: await db
      .select()
      .from(instruments)
      .where(eq(instruments.id, A)),
    runs,
    files: await db
      .select()
      .from(files)
      .where(inArray(files.instrumentRunId, runIds))
      .orderBy(files.id),
    comments: await db
      .select()
      .from(runComments)
      .where(inArray(runComments.runId, runIds))
      .orderBy(runComments.id),
    links: await db
      .select()
      .from(runNotebookLinks)
      .where(inArray(runNotebookLinks.runId, runIds))
      .orderBy(runNotebookLinks.id),
    jobs: await db
      .select()
      .from(archiveJobs)
      .where(inArray(archiveJobs.instrumentRunId, runIds))
      .orderBy(archiveJobs.id),
  };
}

describe("a watcher's token writes only to its own instrument", () => {
  let tokenA: string;
  let tokenB: string;
  let unboundToken: string;
  let watcherAId: string;
  let fixture: Fixture;
  let before: Awaited<ReturnType<typeof snapshotInstrumentA>>;

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
    expect(res.ok).toBe(true);
  }

  beforeAll(async () => {
    await resetDb();
    const scopes = [...ALL_SCOPES];
    let userId: string;
    ({ token: tokenA, userId } = await seedTestUser({ scopes }));
    ({ token: tokenB } = await seedTestUser({ scopes }));
    ({ token: unboundToken } = await seedTestUser({ scopes }));

    const db = getTestDb();
    await db.insert(instruments).values([
      { id: A, displayName: "Scope A", status: "active" },
      { id: B, displayName: "Scope B", status: "active" },
    ]);

    watcherAId = await registerWatcher(tokenA, A);
    await registerWatcher(tokenB, B);
    await createRun(tokenA, A);
    await createRun(tokenB, B);

    const [run] = await db
      .select({ id: instrumentRuns.id })
      .from(instrumentRuns)
      .where(eq(instrumentRuns.instrumentId, A));
    const [file] = await db
      .select({ id: files.id })
      .from(files)
      .where(eq(files.instrumentRunId, run.id));

    const comment = await api(`${RUN_PATH}/comments`, {
      method: "POST",
      token: tokenA,
      body: { body: "from A" },
    });
    expect(comment.status).toBe(201);
    const link = await api(`${RUN_PATH}/notebook-links`, {
      method: "POST",
      token: tokenA,
      body: { url: LINK_URL },
    });
    expect(link.status).toBe(201);
    const [job] = await db
      .insert(archiveJobs)
      .values({ instrumentRunId: run.id, fingerprint: "scope" })
      .returning({ id: archiveJobs.id });

    fixture = {
      commentId: (await comment.json()).id,
      fileId: file.id,
      jobId: job.id,
      linkId: (await link.json()).id,
      userId,
    };
    before = await snapshotInstrumentA();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it.each(
    ROUTES
  )("refuses another instrument's watcher token: $name", async (route) => {
    await expectOwnershipRefusal(await send(route, fixture, tokenB));
  });

  it("left instrument A as it was after every refusal", async () => {
    expect(await snapshotInstrumentA()).toEqual(before);
  });

  it("refuses a bulk notebook-link request that names a run on another instrument", async () => {
    const res = await api("/api/v1/instrument-runs/notebook-links", {
      method: "POST",
      token: tokenA,
      body: {
        runs: [
          { instrument_id: A, run_id: RUN },
          { instrument_id: B, run_id: RUN },
        ],
        url: "https://example.com/eln/scope-4",
      },
    });
    await expectOwnershipRefusal(res);
  });

  it("refuses every watcher token on PATCH /instruments/:id, its own instrument included", async () => {
    for (const token of [tokenA, tokenB]) {
      const res = await api(`/api/v1/instruments/${A}`, {
        method: "PATCH",
        token,
        body: { display_name: "Renamed" },
      });
      await expectOwnershipRefusal(res);
    }
    const [row] = await getTestDb()
      .select({ displayName: instruments.displayName })
      .from(instruments)
      .where(eq(instruments.id, A));
    expect(row.displayName).toBe("Scope A");
  });

  it("lets a token that registered no watcher edit an instrument", async () => {
    const res = await api(`/api/v1/instruments/${B}`, {
      method: "PATCH",
      token: unboundToken,
      body: { display_name: "Scope B renamed" },
    });
    expect(res.status).toBe(200);
  });

  it("lets a signed-in member act on any instrument", async () => {
    const cookie = await seedSessionCookie(fixture.userId);
    const res = await api(`${RUN_PATH}/comments`, {
      method: "POST",
      headers: { cookie },
      body: { body: "from a person" },
    });
    expect(res.status).toBe(201);
  });

  it.each(
    ROUTES
  )("lets a token that registered no watcher through: $name", async (route) => {
    await expectNotOwnershipRefusal(await send(route, fixture, unboundToken));
  });

  it.each(
    ROUTES
  )("lets the instrument's own watcher token through: $name", async (route) => {
    await expectNotOwnershipRefusal(await send(route, fixture, tokenA));
  });

  it("refuses a watcher's token once its watcher is deregistered", async () => {
    await getTestDb()
      .update(watchers)
      .set({ deletedAt: new Date() })
      .where(eq(watchers.id, watcherAId));

    for (const route of ROUTES.slice(0, 5)) {
      await expectOwnershipRefusal(await send(route, fixture, tokenA));
    }
  });
});
