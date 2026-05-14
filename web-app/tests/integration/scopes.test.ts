import { instruments } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Exercises the scope guard inserted by requireScope() in the v1 route
// handlers. Each test seeds a fresh PAT with a specific scopes array and
// then hits a read + write endpoint to confirm that:
//
//   - present scope → 200/201/... (the route's normal success path)
//   - missing scope → 403 FORBIDDEN with the standard `{ error: { code,
//     message } }` body
//
// The full allow/deny matrix is exercised against the runs surface because
// it has both a `:read` and a `:write` route handler that are cheap to
// invoke and don't require fixture files in S3.
describe("PAT scopes", () => {
  const instrumentId = "scopes-test-instrument";

  beforeAll(async () => {
    await resetDb();
    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Scopes Test Instrument",
      status: "active",
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // runs:read — allowed to GET, blocked on POST
  // -------------------------------------------------------------------------

  it("['runs:read'] can GET runs but is 403 on POST", async () => {
    const { token } = await seedTestUser({ scopes: ["runs:read"] });

    const getRes = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      token,
    });
    expect(getRes.status).toBe(200);

    const postRes = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: { run_id: "scoped-read-run", source: "lambda" },
    });
    expect(postRes.status).toBe(403);
    const body = await postRes.json();
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toMatch(/missing required scope: runs:write/);
  });

  // -------------------------------------------------------------------------
  // runs:write — allowed to POST. (We don't assert GET-denied here because
  // some callers grant both `:read` and `:write` for the same noun, and the
  // route enforcement is the same one tested in the read-only case above.)
  // -------------------------------------------------------------------------

  it("['runs:write'] can POST runs", async () => {
    const { token } = await seedTestUser({ scopes: ["runs:write"] });

    const postRes = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: { run_id: "scoped-write-run", source: "lambda" },
    });
    expect(postRes.status).toBe(201);
  });

  // -------------------------------------------------------------------------
  // ['*'] — wildcard matches every scope (used for the backfill / watcher
  // PATs). Same fixture as the seedTestUser default, asserted explicitly so
  // a future change to the default value can't silently weaken this test.
  // -------------------------------------------------------------------------

  it("['*'] grants every scope", async () => {
    const { token } = await seedTestUser({ scopes: ["*"] });

    const instrumentsRes = await api("/api/v1/instruments", { token });
    expect(instrumentsRes.status).toBe(200);

    const runsGet = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      token,
    });
    expect(runsGet.status).toBe(200);

    const runsPost = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: { run_id: "wildcard-run", source: "lambda" },
    });
    // 200 if a previous test (or the dedup race below) already inserted
    // this run, 201 on a fresh insert. Either status proves the scope
    // check let the request through.
    expect([200, 201]).toContain(runsPost.status);
  });

  // -------------------------------------------------------------------------
  // [] — empty scopes list, every authenticated request is 403.
  // -------------------------------------------------------------------------

  it("[] is 403 on every protected route", async () => {
    const { token } = await seedTestUser({ scopes: [] });

    const instrumentsRes = await api("/api/v1/instruments", { token });
    expect(instrumentsRes.status).toBe(403);
    const body = await instrumentsRes.json();
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toMatch(
      /missing required scope: instruments:read/
    );

    const runsGet = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      token,
    });
    expect(runsGet.status).toBe(403);

    const runsPost = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: { run_id: "no-scope-run", source: "lambda" },
    });
    expect(runsPost.status).toBe(403);
  });
});
