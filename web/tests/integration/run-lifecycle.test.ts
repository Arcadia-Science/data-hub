import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instrumentRuns, instruments } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// Covers the soft-delete / restore REST lifecycle. The key regression guard
// here is that `POST .../restore` echoes the run's internal `id` — an earlier
// refactor dropped it, which is a breaking change for v1 clients.

describe("Run lifecycle API (delete / restore)", () => {
  let token: string;
  const instrumentId = "lifecycle-test-instrument";
  const runId = "lifecycle-test-run";
  let runUuid: string;

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Lifecycle Test Instrument",
      status: "active",
    });

    await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: { run_id: runId, source: "lambda" },
    });

    const [run] = await db
      .select({ id: instrumentRuns.id })
      .from(instrumentRuns)
      .where(
        and(
          eq(instrumentRuns.instrumentId, instrumentId),
          eq(instrumentRuns.runId, runId)
        )
      );
    runUuid = run.id;
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("restore returns the run's internal id and clears deleted_at", async () => {
    const del = await api(`/api/v1/instruments/${instrumentId}/runs/${runId}`, {
      method: "DELETE",
      token,
    });
    expect(del.status).toBe(200);

    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/restore`,
      { method: "POST", token }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(runUuid);
    expect(body.instrument_id).toBe(instrumentId);
    expect(body.run_id).toBe(runId);
    expect(body.deleted_at).toBeNull();
  });

  it("restore on a run that isn't deleted returns 409", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/restore`,
      { method: "POST", token }
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
  });
});
