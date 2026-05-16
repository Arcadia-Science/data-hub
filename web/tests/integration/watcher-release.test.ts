import { instruments, watcherReleaseConfig } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// The `/api/v1/watcher-release` surface is admin-only and session-only —
// PATs never pass the gate. Mirroring the `users.test.ts` pattern, the
// negative cases are locked down here; the session-authenticated happy
// path (admin saving via the UI) is covered by manual QA per the PR
// description.
//
// The end-to-end "settings page → update-check" wiring is verified by
// upserting the singleton row directly via Drizzle and asserting the
// public `update-check` endpoint reflects the change. This keeps the
// schema → route → wire-response chain exercised without depending on a
// session synthesised by the harness.

describe("Watcher Release API admin gate", () => {
  let token: string;

  beforeAll(async () => {
    await resetDb();
    // Seeding an admin user doesn't help here — PATs never carry a
    // session, and `requireAdmin()` only consults the NextAuth session.
    // This intentionally makes "PAT tries to manage the release" a 401,
    // not a 403, so the failure mode is clearly "session required".
    ({ token } = await seedTestUser({ isAdmin: true }));
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("GET /api/v1/watcher-release rejects PAT auth (session required)", async () => {
    const res = await api("/api/v1/watcher-release", { token });
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/watcher-release rejects unauthenticated requests", async () => {
    const res = await api("/api/v1/watcher-release");
    expect(res.status).toBe(401);
  });

  it("PUT /api/v1/watcher-release rejects PAT auth", async () => {
    const res = await api("/api/v1/watcher-release", {
      method: "PUT",
      token,
      body: {
        latest_version: "1.0.0",
        min_supported_version: null,
        channel: "stable",
        mandatory: false,
      },
    });
    expect(res.status).toBe(401);
  });

  it("PUT /api/v1/watcher-release rejects unauthenticated requests", async () => {
    const res = await api("/api/v1/watcher-release", {
      method: "PUT",
      body: {
        latest_version: "1.0.0",
        min_supported_version: null,
        channel: "stable",
        mandatory: false,
      },
    });
    expect(res.status).toBe(401);
  });
});

// Direct DB write → public read. Bypassing the admin-only write endpoint
// here is intentional: it isolates the schema → /update-check chain from
// the (separately-tested) session auth gate, so a regression in either
// half points cleanly at its half.
describe("Watcher Release singleton flows through update-check", () => {
  let token: string;
  let watcherId: string;
  const instrumentId = "watcher-release-test-instrument";

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Watcher Release Test Instrument",
      status: "active",
    });

    // Register a watcher to call update-check against. Using the public
    // route (rather than a direct insert) keeps the test honest about
    // the active-watcher invariants update-check relies on.
    const res = await api("/api/v1/watchers/register", {
      method: "POST",
      token,
      body: {
        instrument_id: instrumentId,
        hostname: "release-test-lab-pc",
        os_info: "Linux integration-test",
      },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    watcherId = data.watcher_id;
  });

  // After each test, restore the singleton to the global-setup defaults
  // so the assertions in `watchers.test.ts` (which expects 9.9.9) stay
  // independent of test ordering.
  afterEach(async () => {
    const db = getTestDb();
    await db
      .insert(watcherReleaseConfig)
      .values({
        id: true,
        latestVersion: "9.9.9",
        minSupportedVersion: "0.1.0",
        channel: "stable",
        mandatory: false,
      })
      .onConflictDoUpdate({
        target: watcherReleaseConfig.id,
        set: {
          latestVersion: "9.9.9",
          minSupportedVersion: "0.1.0",
          channel: "stable",
          mandatory: false,
        },
      });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("update-check reflects a direct upsert into watcher_release_config", async () => {
    const db = getTestDb();
    await db
      .insert(watcherReleaseConfig)
      .values({
        id: true,
        latestVersion: "1.2.3",
        minSupportedVersion: "1.0.0",
        channel: "beta",
        mandatory: true,
      })
      .onConflictDoUpdate({
        target: watcherReleaseConfig.id,
        set: {
          latestVersion: "1.2.3",
          minSupportedVersion: "1.0.0",
          channel: "beta",
          mandatory: true,
        },
      });

    const res = await api(`/api/v1/watchers/${watcherId}/update-check`, {
      token,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      latest_version: "1.2.3",
      min_supported_version: "1.0.0",
      channel: "beta",
      mandatory: true,
    });
  });

  it("update-check collapses mandatory→false when latest_version is null", async () => {
    // Mirrors the invariant baked into `readReleaseInfo()`: advertising
    // `mandatory: true` while no version is offered would be nonsensical
    // on the wire, so the route forces it false on read. This guards
    // against a future schema change accidentally leaking the raw value.
    const db = getTestDb();
    await db
      .insert(watcherReleaseConfig)
      .values({
        id: true,
        latestVersion: null,
        minSupportedVersion: null,
        channel: "stable",
        mandatory: true,
      })
      .onConflictDoUpdate({
        target: watcherReleaseConfig.id,
        set: {
          latestVersion: null,
          minSupportedVersion: null,
          channel: "stable",
          mandatory: true,
        },
      });

    const res = await api(`/api/v1/watchers/${watcherId}/update-check`, {
      token,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      latest_version: null,
      min_supported_version: null,
      channel: "stable",
      mandatory: false,
    });
  });

  it("update-check falls back to defaults when the singleton row is missing", async () => {
    // Fresh-deploy / pre-seed shape. Deleting and reading verifies the
    // route's "no row" branch still returns 200 (rather than 500), so
    // watchers don't log spurious errors before any admin has saved.
    const db = getTestDb();
    await db
      .delete(watcherReleaseConfig)
      .where(eq(watcherReleaseConfig.id, true));

    const res = await api(`/api/v1/watchers/${watcherId}/update-check`, {
      token,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      latest_version: null,
      min_supported_version: null,
      channel: "stable",
      mandatory: false,
    });
  });

  it("singleton check constraint rejects a second row", async () => {
    // The `id boolean PRIMARY KEY` + `CHECK (id = true)` schema-level
    // guarantee that exactly 0 or 1 rows can exist is the whole reason
    // route handlers can skip LIMIT 1 / ORDER BY discipline. If a
    // future migration relaxes this without updating the routes, both
    // halves of the invariant should break together.
    const db = getTestDb();
    await expect(
      db.execute(
        sql`INSERT INTO watcher_release_config (id, channel) VALUES (false, 'stable')`
      )
    ).rejects.toThrow();
  });
});
