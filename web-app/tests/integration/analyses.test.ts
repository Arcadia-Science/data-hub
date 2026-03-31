import { instruments } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("Analyses API", () => {
  let token: string;
  const instrumentId = "analyses-test-instrument";
  const runId = "analyses-test-run";

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Analyses Test Instrument",
      status: "active",
    });

    await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: { run_id: runId, source: "lambda" },
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // The analyses endpoints are currently stubbed (501). These tests verify
  // that the stubs are wired up and auth-protected.

  it("POST /analyses returns 501 (not implemented)", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/analyses`,
      { method: "POST", token, body: {} }
    );
    expect(res.status).toBe(501);
    const data = await res.json();
    expect(data.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("GET /analyses returns 501 (not implemented)", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/analyses`,
      { token }
    );
    expect(res.status).toBe(501);
    const data = await res.json();
    expect(data.error.code).toBe("NOT_IMPLEMENTED");
  });

  it("POST /analyses requires authentication", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/analyses`,
      { method: "POST", body: {} }
    );
    expect(res.status).toBe(401);
  });

  it("GET /analyses requires authentication", async () => {
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/analyses`
    );
    expect(res.status).toBe(401);
  });
});
