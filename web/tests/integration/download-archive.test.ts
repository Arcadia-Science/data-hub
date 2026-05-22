import { instrumentRuns, instruments } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getBaseUrl,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Tests for GET /api/v1/instruments/:instrumentId/runs/:runId/download-archive.
//
// The route is now a thin wrapper that delegates orchestration (cache
// HEAD, dedup INSERT, Lambda invocation) to `prepareRunArchive`. These
// tests cover the parts the route itself owns:
//
//   - auth gate (`authorize(request, "files:read")`)
//   - scope enforcement (`files:read`)
//   - the JSON-vs-redirect Accept header switch for terminal responses
//   - mapping the helper's `{ ok: false, status: 503 }` result to the
//     standard `{ error: { code: "INTERNAL_ERROR", … } }` envelope
//
// Cache-hit/cache-miss orchestration (S3 HEAD, partial-unique-index
// dedup, `after()` Lambda invocation) is exercised by the helper-level
// tests in `archive-jobs.test.ts` and the in-memory MCP tests in
// `tests/mcp/mcp-protocol.test.ts`. The integration suite intentionally
// does not stand up real S3 / a real Lambda Function URL — the test
// global-setup strips `LAMBDA_FUNCTION_URL` for exactly this reason —
// so any "happy path" download here would either need a stub server we
// don't have, or hit real AWS, which we don't want to do in CI.
describe("Download Archive Route", () => {
  const instrumentId = "download-archive-test-instrument";
  const runId = "download-archive-test-run";

  beforeAll(async () => {
    await resetDb();

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Download Archive Test Instrument",
      status: "active",
    });
    await db.insert(instrumentRuns).values({
      instrumentId,
      runId,
      source: "watcher",
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it("returns 401 when no Authorization header is present", async () => {
    const res = await fetch(
      `${getBaseUrl()}/api/v1/instruments/${instrumentId}/runs/${runId}/download-archive`
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 for an invalid bearer token", async () => {
    const res = await fetch(
      `${getBaseUrl()}/api/v1/instruments/${instrumentId}/runs/${runId}/download-archive`,
      { headers: { Authorization: "Bearer dhub_not-a-real-token" } }
    );
    expect(res.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Scopes — the route requires `files:read`. A token with only
  // `runs:read` should be rejected with 403 FORBIDDEN, never reaching
  // the archive-builder configuration check below.
  // -------------------------------------------------------------------------

  it("returns 403 for a token without files:read", async () => {
    const { token } = await seedTestUser({ scopes: ["runs:read"] });

    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/download-archive`,
      { token }
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toMatch(/files:read/);
  });

  // -------------------------------------------------------------------------
  // 503 — `prepareRunArchive` short-circuits with `{ status: 503 }`
  // when the archive builder isn't configured. The integration test env
  // strips `LAMBDA_FUNCTION_URL` (see global-setup.ts), so every
  // properly-authorized request through this route lands in this branch.
  // The route must:
  //   - return HTTP 503 (not 500)
  //   - emit the standard `{ error: { code, message } }` envelope with
  //     `code === "INTERNAL_ERROR"` (the route's mapping for the 503 branch)
  //   - mention the missing env vars so a deploy-time misconfig is
  //     immediately diagnosable from the response body alone
  //   - return JSON regardless of `Accept` (the cache-miss/redirect path
  //     never runs because the helper short-circuits before the HEAD)
  // -------------------------------------------------------------------------

  it("returns 503 with INTERNAL_ERROR when the archive builder is not configured", async () => {
    const { token } = await seedTestUser({ scopes: ["files:read"] });

    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/download-archive`,
      { token }
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toMatch(/Archive builder is not configured/);
    expect(body.error.message).toMatch(/LAMBDA_FUNCTION_URL/);
    expect(body.error.message).toMatch(/S3_ARCHIVES_BUCKET/);
  });

  it("returns 503 even when the run does not exist (config check runs first)", async () => {
    const { token } = await seedTestUser({ scopes: ["files:read"] });

    // The helper checks `isArchiveBuilderConfigured()` BEFORE
    // `lookupRunByNaturalKey`, so a missing run never reaches the 404
    // branch in this env. Asserting on this ordering pins the contract:
    // a 404 here would mean someone reordered the helper's preflights
    // and would surface "no such run" to clients on a misconfigured
    // deploy — strictly worse than the current "fix your env vars" 503.
    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/no-such-run/download-archive`,
      { token }
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });

  it("returns 503 as JSON regardless of Accept header (no 302 on errors)", async () => {
    const { token } = await seedTestUser({ scopes: ["files:read"] });

    // Browser-style request (no `Accept: application/json`). The route
    // only emits a 302 on the `status: "ready"` cache-hit branch; an
    // error or building response is always JSON so callers can read the
    // failure body without following a redirect into S3.
    const res = await fetch(
      `${getBaseUrl()}/api/v1/instruments/${instrumentId}/runs/${runId}/download-archive`,
      {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
      }
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("location")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Wildcard scope — the seeded default. Confirms `["*"]` covers
  // `files:read` and reaches the same 503 branch as the explicit grant
  // above. Pinned so a future change to the wildcard semantics can't
  // silently start denying archive downloads to legacy PATs.
  // -------------------------------------------------------------------------

  it("['*'] grants files:read and reaches the helper", async () => {
    const { token } = await seedTestUser({ scopes: ["*"] });

    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/download-archive`,
      { token }
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});
