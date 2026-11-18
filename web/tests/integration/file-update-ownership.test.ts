import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SCOPE_PRESETS } from "@/lib/api/scope-catalog";
import { files, instrumentRuns, instruments, watchers } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// PATCH /files/:id lets a watcher's token change only its own instrument's
// files. The Lambda's token registered no watcher, so it may still change any
// instrument's files.

function presetScopes(id: string): string[] {
  const preset = SCOPE_PRESETS.find((p) => p.id === id);
  if (!preset) {
    throw new Error(`Scope preset '${id}' is missing`);
  }
  return [...preset.scopes];
}

const INSTRUMENT_A = "ownership-instr-a";
const INSTRUMENT_B = "ownership-instr-b";
const RUN_ID = "ownership-run";

describe("PATCH /files/:id ownership", () => {
  let tokenA: string;
  let tokenB: string;
  let lambdaToken: string;
  let watcherAId: string;

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
        run_id: RUN_ID,
        source: "watcher",
        detected_files: [
          { relative_path: "one.csv", filename: "one.csv", size_bytes: 1 },
          { relative_path: "two.csv", filename: "two.csv", size_bytes: 1 },
        ],
      },
    });
    expect(res.ok).toBe(true);
  }

  async function fileId(instrumentId: string, filename: string) {
    const [row] = await getTestDb()
      .select({ id: files.id })
      .from(files)
      .innerJoin(instrumentRuns, eq(instrumentRuns.id, files.instrumentRunId))
      .where(
        and(
          eq(instrumentRuns.instrumentId, instrumentId),
          eq(files.filename, filename)
        )
      )
      .limit(1);
    if (!row) {
      throw new Error(`No file '${filename}' on '${instrumentId}'`);
    }
    return row.id;
  }

  async function fileStatus(id: number) {
    const [row] = await getTestDb()
      .select({ status: files.status })
      .from(files)
      .where(eq(files.id, id))
      .limit(1);
    return row?.status;
  }

  async function setStatus(
    id: number,
    status: "upload_requested" | "uploaded"
  ): Promise<void> {
    await getTestDb()
      .update(files)
      .set({
        status,
        uploadRequestedAt: status === "upload_requested" ? new Date() : null,
      })
      .where(eq(files.id, id));
  }

  function patchFile(token: string, id: number, body: unknown) {
    return api(`/api/v1/files/${id}`, { method: "PATCH", token, body });
  }

  beforeAll(async () => {
    await resetDb();
    ({ token: tokenA } = await seedTestUser({
      scopes: presetScopes("watcher"),
    }));
    ({ token: tokenB } = await seedTestUser({
      scopes: presetScopes("watcher"),
    }));
    ({ token: lambdaToken } = await seedTestUser({
      scopes: presetScopes("lambda"),
    }));

    await getTestDb()
      .insert(instruments)
      .values([
        { id: INSTRUMENT_A, displayName: "Ownership A", status: "active" },
        { id: INSTRUMENT_B, displayName: "Ownership B", status: "active" },
      ]);

    watcherAId = await registerWatcher(tokenA, INSTRUMENT_A);
    await registerWatcher(tokenB, INSTRUMENT_B);
    await createRun(tokenA, INSTRUMENT_A);
    await createRun(tokenB, INSTRUMENT_B);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("refuses another instrument's watcher and leaves the file as it was", async () => {
    const id = await fileId(INSTRUMENT_B, "one.csv");
    await setStatus(id, "upload_requested");

    for (const status of ["detected", "uploaded"]) {
      const res = await patchFile(tokenA, id, { status });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toMatch(/not authorized for this file/);
    }

    expect(await fileStatus(id)).toBe("upload_requested");
  });

  it("lets a watcher cancel a request and mark an upload done on its own instrument", async () => {
    const id = await fileId(INSTRUMENT_B, "one.csv");
    await setStatus(id, "upload_requested");

    const cancelled = await patchFile(tokenB, id, { status: "detected" });
    expect(cancelled.status).toBe(200);
    expect(await fileStatus(id)).toBe("detected");

    const uploaded = await patchFile(tokenB, id, { status: "uploaded" });
    expect(uploaded.status).toBe(200);
    expect(await fileStatus(id)).toBe("uploaded");
  });

  it("lets the Lambda token change files on every instrument", async () => {
    for (const instrumentId of [INSTRUMENT_A, INSTRUMENT_B]) {
      const id = await fileId(instrumentId, "two.csv");
      await setStatus(id, "uploaded");

      const res = await patchFile(lambdaToken, id, { status: "processing" });
      expect(res.status).toBe(200);
      expect(await fileStatus(id)).toBe("processing");
    }
  });

  it("refuses a watcher's token once its watcher is deregistered", async () => {
    const id = await fileId(INSTRUMENT_A, "one.csv");
    await setStatus(id, "upload_requested");

    await getTestDb()
      .update(watchers)
      .set({ deletedAt: new Date() })
      .where(eq(watchers.id, watcherAId));

    const res = await patchFile(tokenA, id, { status: "uploaded" });
    expect(res.status).toBe(403);
    expect(await fileStatus(id)).toBe("upload_requested");
  });
});
