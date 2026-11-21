import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCOPE_PRESETS } from "@/lib/api/scope-catalog";
import { ALL_SCOPES } from "@/lib/api/scopes";
import {
  archiveJobs,
  files,
  instrumentRuns,
  instruments,
  notebooks,
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
import { TEST_RAW_BUCKET } from "@/tests/integration/test-buckets";

// Every write route that names an instrument, run, file or archive job lets a
// watcher's token act only on its own instrument. The watcher tokens here
// list every scope, so they reach routes the Watcher preset alone can't. A
// legacy `*` token no longer would: see watcher-token-legacy-scopes.test.ts. A
// token that registered no watcher, such as the Lambda's, is not limited.

const A = "scope-instr-a";
const B = "scope-instr-b";
const RUN = "scope-run";
const RUN_PATH = `/api/v1/instruments/${A}/runs/${RUN}`;

interface Fixture {
  commentId: string;
  fileId: number;
  jobId: string;
  notebookId: string;
  userId: string;
}

interface RouteCase {
  body?: (f: Fixture) => unknown;
  method: "GET" | "POST" | "PATCH" | "DELETE";
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
      s3_bucket: TEST_RAW_BUCKET,
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
    name: "add a run to a lab notebook",
    method: "POST",
    path: (f) => `/api/v1/lab-notebooks/${f.notebookId}/runs`,
    body: () => ({ runs: [{ instrument_id: A, run_id: RUN }] }),
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
    name: "remove a run from a lab notebook",
    method: "POST",
    path: (f) => `/api/v1/lab-notebooks/${f.notebookId}/runs/remove`,
    body: () => ({ runs: [{ instrument_id: A, run_id: RUN }] }),
  },
  {
    name: "delete a comment",
    method: "DELETE",
    path: (f) => `${RUN_PATH}/comments/${f.commentId}`,
  },
  {
    name: "delete a file",
    method: "DELETE",
    path: (f) => `/api/v1/files/${f.fileId}`,
  },
  {
    name: "delete a file and its linked files",
    method: "DELETE",
    path: (f) => `/api/v1/files/${f.fileId}?include_linked=true`,
  },
  {
    name: "restore a file",
    method: "POST",
    path: (f) => `/api/v1/files/${f.fileId}/restore`,
  },
  {
    name: "delete several files of a run",
    method: "POST",
    path: () => `${RUN_PATH}/files/delete`,
    body: (f) => ({ file_ids: [f.fileId], include_linked: true }),
  },
  {
    name: "restore several files of a run",
    method: "POST",
    path: () => `${RUN_PATH}/files/restore`,
    body: (f) => ({ file_ids: [f.fileId], include_linked: true }),
  },
  {
    name: "list the files linked to some files of a run",
    method: "GET",
    path: (f) => `${RUN_PATH}/files/linked?file_ids=${f.fileId}`,
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
  /not authorized for this (instrument|file's instrument)|can't change instruments|can't remove or reconfigure watchers|can't create or change lab notebooks/;

async function expectOwnershipRefusal(res: Response) {
  expect(res.status).toBe(403);
  const body = await res.json();
  expect(body.error.code).toBe("FORBIDDEN");
  expect(body.error.message).toMatch(OWNERSHIP_REFUSAL);
}

async function expectNotOwnershipRefusal(res: Response) {
  expect(res.status).toBeLessThan(500);
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
    // A watcher's token can't create a notebook, but it can add its own
    // instrument's run to one.
    const notebook = await api("/api/v1/lab-notebooks", {
      method: "POST",
      token: unboundToken,
      body: {
        url: "https://example.com/eln/scope-1",
        name: "Scope lab notebook",
      },
    });
    expect(notebook.status).toBe(201);
    const notebookId = (await notebook.json()).lab_notebook.id as string;
    const added = await api(`/api/v1/lab-notebooks/${notebookId}/runs`, {
      method: "POST",
      token: tokenA,
      body: { runs: [{ instrument_id: A, run_id: RUN }] },
    });
    expect(added.status).toBe(200);
    const [job] = await db
      .insert(archiveJobs)
      .values({ instrumentRunId: run.id, fingerprint: "scope" })
      .returning({ id: archiveJobs.id });

    fixture = {
      commentId: (await comment.json()).id,
      fileId: file.id,
      jobId: job.id,
      notebookId,
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

  it("lets a Watcher-preset token report a run and upload a file on its own instrument", async () => {
    const C = "scope-instr-c";
    const preset = SCOPE_PRESETS.find((p) => p.id === "watcher");
    if (!preset) {
      throw new Error("Scope preset 'watcher' is missing");
    }
    const { token } = await seedTestUser({ scopes: [...preset.scopes] });
    await getTestDb()
      .insert(instruments)
      .values({ id: C, displayName: "Scope C", status: "active" });
    const watcherId = await registerWatcher(token, C);
    const runPath = `/api/v1/instruments/${C}/runs/${RUN}`;

    const created = await api(`/api/v1/instruments/${C}/runs`, {
      method: "POST",
      token,
      body: {
        run_id: RUN,
        source: "watcher",
        watcher_id: watcherId,
        detected_files: [
          { relative_path: "one.csv", filename: "one.csv", size_bytes: 1 },
        ],
      },
    });
    expect(created.status).toBe(201);

    const updated = await api(runPath, {
      method: "PATCH",
      token,
      body: {
        detected_files: [
          { relative_path: "two.csv", filename: "two.csv", size_bytes: 1 },
        ],
      },
    });
    expect(updated.status).toBe(200);

    const link = await api(`${runPath}/request-upload-url`, {
      method: "POST",
      token,
      body: { filename: "one.csv", size_bytes: 1 },
    });
    expect(link.status).toBe(200);
    const { file_id: fileId } = await link.json();

    const uploaded = await api(`/api/v1/files/${fileId}`, {
      method: "PATCH",
      token,
      body: { status: "uploaded" },
    });
    expect(uploaded.status).toBe(200);
  });

  it("refuses adding runs to a lab notebook when one is on another instrument", async () => {
    const res = await api(`/api/v1/lab-notebooks/${fixture.notebookId}/runs`, {
      method: "POST",
      token: tokenA,
      body: {
        runs: [
          { instrument_id: A, run_id: RUN },
          { instrument_id: B, run_id: RUN },
        ],
      },
    });
    await expectOwnershipRefusal(res);
  });

  it("refuses every watcher token on lab notebook create, edit, delete and restore", async () => {
    const notebookPath = `/api/v1/lab-notebooks/${fixture.notebookId}`;
    const adminRoutes: {
      body?: unknown;
      method: "DELETE" | "PATCH" | "POST";
      path: string;
    }[] = [
      {
        method: "POST",
        path: "/api/v1/lab-notebooks",
        body: { url: "https://example.com/eln/scope-2", name: "From a PC" },
      },
      { method: "PATCH", path: notebookPath, body: { name: "Renamed" } },
      { method: "DELETE", path: notebookPath },
      { method: "POST", path: `${notebookPath}/restore` },
    ];
    for (const token of [tokenA, tokenB]) {
      for (const route of adminRoutes) {
        const res = await api(route.path, {
          method: route.method,
          token,
          body: route.body,
        });
        await expectOwnershipRefusal(res);
      }
    }
    const [row] = await getTestDb()
      .select({ name: notebooks.name, deletedAt: notebooks.deletedAt })
      .from(notebooks)
      .where(eq(notebooks.id, fixture.notebookId));
    expect(row).toEqual({ name: "Scope lab notebook", deletedAt: null });
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

  it("refuses every watcher token on the watcher admin routes, its own watcher included", async () => {
    const adminRoutes: { method: "DELETE" | "POST"; path: string }[] = [
      { method: "DELETE", path: `/api/v1/watchers/${watcherAId}` },
      {
        method: "POST",
        path: `/api/v1/watchers/${watcherAId}/config-revisions`,
      },
      { method: "POST", path: `/api/v1/watchers/${watcherAId}/config-preview` },
    ];
    for (const token of [tokenA, tokenB]) {
      for (const route of adminRoutes) {
        const res = await api(route.path, {
          method: route.method,
          token,
          body: route.method === "POST" ? {} : undefined,
        });
        await expectOwnershipRefusal(res);
      }
    }
    const [row] = await getTestDb()
      .select({ deletedAt: watchers.deletedAt })
      .from(watchers)
      .where(eq(watchers.id, watcherAId));
    expect(row.deletedAt).toBeNull();
  });

  it("lets a token that registered no watcher use the watcher admin routes", async () => {
    const res = await api(`/api/v1/watchers/${watcherAId}/config-preview`, {
      method: "POST",
      token: unboundToken,
      body: {},
    });
    await expectNotOwnershipRefusal(res);
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
