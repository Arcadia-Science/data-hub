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
    expect(body.already_applied).toBe(false);
  });

  it("restore on a run that isn't deleted is an idempotent no-op", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/restore`,
      { method: "POST", token }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted_at).toBeNull();
    expect(body.already_applied).toBe(true);
  });

  it("delete on an already-deleted run is an idempotent no-op", async () => {
    const first = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}`,
      { method: "DELETE", token }
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.already_applied).toBe(false);
    expect(firstBody.deleted_at).toBeTruthy();

    const second = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}`,
      { method: "DELETE", token }
    );
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.already_applied).toBe(true);
    // The deletion timestamp is preserved from the first delete, not bumped.
    expect(secondBody.deleted_at).toBe(firstBody.deleted_at);
  });
});
