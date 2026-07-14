import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attributionsResponse, runDetail } from "@/lib/api/openapi";
import { instruments } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// End-to-end tests for the self-service run attribution surface:
//
//   - PUT/DELETE /api/v1/instruments/:instrumentId/runs/:runId/attributions/me
//   - The `ran_by` query-param filter on the runs list endpoints
//   - The `attributions` field embedded in run detail responses
//
// Attribution is strictly self-scoped: the URL and body carry no user id, so
// these tests prove the authenticated token's user is the only user ever
// written and that idempotency holds across duplicate PUT/DELETE calls.
describe("Run Attributions API", () => {
  let tokenA: string;
  let userIdA: string;
  let tokenB: string;
  let userIdB: string;

  const instrumentId = "attributions-test-instrument";

  beforeAll(async () => {
    await resetDb();

    ({ token: tokenA, userId: userIdA } = await seedTestUser());
    ({ token: tokenB, userId: userIdB } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Attributions Test Instrument",
      status: "active",
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // Helpers — create a fresh run per test that needs isolated state.
  // -------------------------------------------------------------------------

  async function createRun(runId: string): Promise<void> {
    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token: tokenA,
      body: { run_id: runId, source: "lambda" },
    });
    expect([200, 201]).toContain(res.status);
  }

  function attributionPath(runId: string): string {
    return `/api/v1/instruments/${instrumentId}/runs/${runId}/attributions/me`;
  }

  // -------------------------------------------------------------------------
  // PUT /attributions/me
  // -------------------------------------------------------------------------

  it("PUT without a token returns 401", async () => {
    const res = await api(attributionPath("run-no-auth"), { method: "PUT" });
    expect(res.status).toBe(401);
  });

  it("PUT on an unknown run returns 404 with NOT_FOUND", async () => {
    const res = await api(attributionPath("does-not-exist"), {
      method: "PUT",
      token: tokenA,
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("PUT claims the run for the authenticated user", async () => {
    const runId = "run-claim-single";
    await createRun(runId);

    const res = await api(attributionPath(runId), {
      method: "PUT",
      token: tokenA,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attributions).toHaveLength(1);
    expect(body.attributions[0].userId).toBe(userIdA);
    expect(body.attributions[0].displayName).toBeTruthy();
    expect(body.attributions[0].initials).toBeTruthy();
    // Drift guard: live responses must match their documented OpenAPI schemas
    // (responses aren't validated at runtime, so this is the only backstop).
    attributionsResponse.parse(body);
  });

  it("PUT is idempotent — claiming twice still yields one entry", async () => {
    const runId = "run-claim-idempotent";
    await createRun(runId);

    await api(attributionPath(runId), { method: "PUT", token: tokenA });
    const res = await api(attributionPath(runId), {
      method: "PUT",
      token: tokenA,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attributions).toHaveLength(1);
    expect(body.attributions[0].userId).toBe(userIdA);
  });

  // -------------------------------------------------------------------------
  // DELETE /attributions/me
  // -------------------------------------------------------------------------

  it("DELETE without a token returns 401", async () => {
    const res = await api(attributionPath("run-no-auth"), { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("DELETE on an unknown run returns 404 with NOT_FOUND", async () => {
    const res = await api(attributionPath("does-not-exist"), {
      method: "DELETE",
      token: tokenA,
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("DELETE removes the attribution", async () => {
    const runId = "run-delete-single";
    await createRun(runId);
    await api(attributionPath(runId), { method: "PUT", token: tokenA });

    const res = await api(attributionPath(runId), {
      method: "DELETE",
      token: tokenA,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attributions).toEqual([]);
    attributionsResponse.parse(body);
  });

  it("DELETE is idempotent — deleting when no attribution exists is a no-op", async () => {
    const runId = "run-delete-noop";
    await createRun(runId);

    const res = await api(attributionPath(runId), {
      method: "DELETE",
      token: tokenA,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attributions).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Two-user ordering
  // -------------------------------------------------------------------------

  it("two users claim the same run — both are attributed, ordered by createdAt", async () => {
    const runId = "run-two-users";
    await createRun(runId);

    const first = await api(attributionPath(runId), {
      method: "PUT",
      token: tokenA,
    });
    expect(first.status).toBe(200);

    const second = await api(attributionPath(runId), {
      method: "PUT",
      token: tokenB,
    });
    expect(second.status).toBe(200);
    const body = await second.json();
    expect(body.attributions).toHaveLength(2);
    expect(body.attributions[0].userId).toBe(userIdA);
    expect(body.attributions[1].userId).toBe(userIdB);
  });

  // -------------------------------------------------------------------------
  // GET /runs?ran_by=...
  // -------------------------------------------------------------------------

  it("GET runs?ran_by=<userId> returns only runs that user claimed", async () => {
    const claimedRunId = "run-filter-claimed";
    const otherRunId = "run-filter-unclaimed";
    await createRun(claimedRunId);
    await createRun(otherRunId);
    await api(attributionPath(claimedRunId), {
      method: "PUT",
      token: tokenA,
    });

    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs?ran_by=${userIdA}&per_page=100`,
      { token: tokenA }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const runIds = body.data.map((r: { run_id: string }) => r.run_id);
    expect(runIds).toContain(claimedRunId);
    expect(runIds).not.toContain(otherRunId);
  });

  it("GET runs?ran_by=unattributed returns only runs with no attributions", async () => {
    // These runs are created fresh for this test, then only one is claimed —
    // the other must show up under the unattributed sentinel. The prior
    // suite-level runs get filtered by the attributions list to stay stable
    // across run order.
    const claimedRunId = "run-unattributed-claimed";
    const unattributedRunId = "run-unattributed-bare";
    await createRun(claimedRunId);
    await createRun(unattributedRunId);
    await api(attributionPath(claimedRunId), {
      method: "PUT",
      token: tokenA,
    });

    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs?ran_by=unattributed&per_page=100`,
      { token: tokenA }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const runIds = body.data.map((r: { run_id: string }) => r.run_id);
    expect(runIds).toContain(unattributedRunId);
    expect(runIds).not.toContain(claimedRunId);
    for (const run of body.data) {
      expect(run.attributions).toEqual([]);
    }
  });

  // -------------------------------------------------------------------------
  // GET /runs/:runId — embedded attributions
  // -------------------------------------------------------------------------

  it("GET run detail includes the attributions array", async () => {
    const runId = "run-detail-attributions";
    await createRun(runId);
    await api(attributionPath(runId), { method: "PUT", token: tokenA });

    const res = await api(`/api/v1/instruments/${instrumentId}/runs/${runId}`, {
      token: tokenA,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.attributions)).toBe(true);
    expect(body.attributions).toHaveLength(1);
    expect(body.attributions[0].userId).toBe(userIdA);
    runDetail.parse(body);
  });
});
