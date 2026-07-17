import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { instruments, watcherReleaseConfig, watchers } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// The `/api/v1/settings/watcher-release` surface is admin-only and
// session-only — PATs never pass the gate. Mirroring the
// `users.test.ts` pattern, the negative cases are locked down here; the
// session-authenticated happy path (admin saving via the UI) is covered
// by manual QA per the PR description.
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

  it("GET /api/v1/settings/watcher-release rejects PAT auth (session required)", async () => {
    const res = await api("/api/v1/settings/watcher-release", { token });
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/settings/watcher-release rejects unauthenticated requests", async () => {
    const res = await api("/api/v1/settings/watcher-release");
    expect(res.status).toBe(401);
  });

  it("PUT /api/v1/settings/watcher-release rejects PAT auth", async () => {
    const res = await api("/api/v1/settings/watcher-release", {
      method: "PUT",
      token,
      body: {
        latest_version: "1.0.0",
        min_supported_version: null,
        mandatory: false,
      },
    });
    expect(res.status).toBe(401);
  });

  it("PUT /api/v1/settings/watcher-release rejects unauthenticated requests", async () => {
    const res = await api("/api/v1/settings/watcher-release", {
      method: "PUT",
      body: {
        latest_version: "1.0.0",
        min_supported_version: null,
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
        mandatory: false,
      })
      .onConflictDoUpdate({
        target: watcherReleaseConfig.id,
        set: {
          latestVersion: "9.9.9",
          minSupportedVersion: "0.1.0",
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
        mandatory: true,
      })
      .onConflictDoUpdate({
        target: watcherReleaseConfig.id,
        set: {
          latestVersion: "1.2.3",
          minSupportedVersion: "1.0.0",
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
        mandatory: true,
      })
      .onConflictDoUpdate({
        target: watcherReleaseConfig.id,
        set: {
          latestVersion: null,
          minSupportedVersion: null,
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
      db.execute(sql`INSERT INTO watcher_release_config (id) VALUES (false)`)
    ).rejects.toThrow();
  });
});

// Enforcement of `min_supported_version` on the heartbeat path. The route
// reads the singleton release row on every heartbeat and refuses to
// record anything when the reported version is below the floor — the
// "block_heartbeat" enforcement mode chosen for this rollout. We vary the
// row directly via Drizzle to isolate the schema → heartbeat-route chain
// from the (separately-tested) admin write surface.
describe("Heartbeat enforces watcher_release_config.min_supported_version", () => {
  let token: string;
  let watcherId: string;
  const instrumentId = "watcher-floor-test-instrument";

  // Set the singleton's `min_supported_version` for the current test.
  // Wrapped in a helper so each test reads as "set floor → heartbeat →
  // assert", without the upsert boilerplate drowning the intent.
  async function setFloor(floor: string | null) {
    const db = getTestDb();
    await db
      .insert(watcherReleaseConfig)
      .values({
        id: true,
        latestVersion: "9.9.9",
        minSupportedVersion: floor,
        mandatory: false,
      })
      .onConflictDoUpdate({
        target: watcherReleaseConfig.id,
        set: {
          latestVersion: "9.9.9",
          minSupportedVersion: floor,
          mandatory: false,
        },
      });
  }

  function heartbeat(body: Record<string, unknown>) {
    return api(`/api/v1/watchers/${watcherId}/heartbeat`, {
      method: "POST",
      token,
      body,
    });
  }

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Watcher Floor Test Instrument",
      status: "active",
    });

    const res = await api("/api/v1/watchers/register", {
      method: "POST",
      token,
      body: {
        instrument_id: instrumentId,
        hostname: "floor-test-lab-pc",
        os_info: "Linux integration-test",
      },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    watcherId = data.watcher_id;
  });

  afterEach(async () => {
    // Restore the global-setup baseline so this file's earlier
    // `update-check` assertions (and any later tests) stay deterministic.
    await setFloor("0.1.0");
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("rejects below-floor watcher_version with 426 UPGRADE_REQUIRED", async () => {
    await setFloor("1.0.0");
    const res = await heartbeat({
      status: "watching",
      watcher_version: "0.5.0",
    });
    expect(res.status).toBe(426);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: "UPGRADE_REQUIRED",
        message: expect.stringContaining("0.5.0"),
        details: {
          current_version: "0.5.0",
          min_supported_version: "1.0.0",
          latest_version: "9.9.9",
        },
      },
    });
  });

  it("does not touch the watcher row when rejecting below-floor heartbeats", async () => {
    // Set a known baseline via an at-floor heartbeat first, then verify
    // the subsequent below-floor rejection leaves both the stored
    // version and lastHeartbeatAt exactly where they were. This guards
    // the "rejection is fully side-effect-free" invariant the dashboard
    // staleness rule depends on to surface below-floor watchers as
    // stale rather than as having silently kept checking in.
    await setFloor("1.0.0");
    const okRes = await heartbeat({
      status: "watching",
      watcher_version: "1.0.0",
    });
    expect(okRes.status).toBe(200);

    const db = getTestDb();
    const [before] = await db
      .select({
        watcherVersion: watchers.watcherVersion,
        lastHeartbeatAt: watchers.lastHeartbeatAt,
      })
      .from(watchers)
      .where(eq(watchers.id, watcherId));
    expect(before.watcherVersion).toBe("1.0.0");

    const rejectRes = await heartbeat({
      status: "watching",
      watcher_version: "0.5.0",
    });
    expect(rejectRes.status).toBe(426);

    const [after] = await db
      .select({
        watcherVersion: watchers.watcherVersion,
        lastHeartbeatAt: watchers.lastHeartbeatAt,
      })
      .from(watchers)
      .where(eq(watchers.id, watcherId));
    expect(after.watcherVersion).toBe(before.watcherVersion);
    expect(after.lastHeartbeatAt?.toISOString()).toBe(
      before.lastHeartbeatAt?.toISOString()
    );
  });

  it("accepts a watcher_version equal to the floor", async () => {
    await setFloor("1.0.0");
    const res = await heartbeat({
      status: "watching",
      watcher_version: "1.0.0",
    });
    expect(res.status).toBe(200);
  });

  it("accepts a watcher_version above the floor", async () => {
    await setFloor("1.0.0");
    const res = await heartbeat({
      status: "watching",
      watcher_version: "2.0.0",
    });
    expect(res.status).toBe(200);
  });

  it("accepts heartbeats missing watcher_version (old-watcher back-compat)", async () => {
    // Pre-0.3.0 watchers don't report a version. Blocking them would
    // orphan still-supported lab PCs whose only crime is not yet
    // self-updating to a version that ships the version field, so the
    // comparator's fail-safe default lets them through.
    await setFloor("1.0.0");
    const res = await heartbeat({ status: "watching" });
    expect(res.status).toBe(200);
  });

  it("accepts heartbeats with an unparseable watcher_version", async () => {
    // Mirrors the fail-safe philosophy in `evaluate_update` on the
    // watcher side: if either side of the comparison can't be parsed
    // we refuse to act on it, so a malformed string never spuriously
    // orphans an otherwise-healthy watcher.
    await setFloor("1.0.0");
    const res = await heartbeat({
      status: "watching",
      watcher_version: "not-a-version",
    });
    expect(res.status).toBe(200);
  });

  it("accepts any version when the floor is null", async () => {
    await setFloor(null);
    const res = await heartbeat({
      status: "watching",
      watcher_version: "0.0.1",
    });
    expect(res.status).toBe(200);
  });
});
