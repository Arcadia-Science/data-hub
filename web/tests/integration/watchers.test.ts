import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  watcherChecksumResponse,
  watcherDeleted,
  watcherDetail,
  watcherEventCreated,
  watcherEventsListResponse,
  watcherHeartbeatAck,
  watcherHeartbeatsListResponse,
  watcherListResponse,
  watcherRegistered,
  watcherUpdateCheckResponse,
} from "@/lib/api/openapi";
import { instruments, watchers } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// Tests run sequentially within this file, building state progressively:
// register → heartbeat → events → config → delete → verify soft-delete behavior.
// This mirrors the real watcher lifecycle (CLI registers, sends heartbeats,
// reports events, syncs config, and eventually deregisters).
describe("Watchers API", () => {
  let token: string;
  let watcherId: string;
  const instrumentId = "watcher-test-instrument";

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Watcher Test Instrument",
      status: "active",
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/watchers/register
  // -------------------------------------------------------------------------

  it("POST /api/v1/watchers/register creates a watcher", async () => {
    const res = await api("/api/v1/watchers/register", {
      method: "POST",
      token,
      body: {
        instrument_id: instrumentId,
        hostname: "lab-pc-01",
        os_info: "Windows 11",
      },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.watcher_id).toBeTruthy();
    watcherId = data.watcher_id;
    // Drift guard: live responses must match their documented OpenAPI schemas
    // (responses aren't validated at runtime, so this is the only backstop).
    watcherRegistered.parse(data);
  });

  // Enforces the 1:1 active-watcher-per-instrument invariant. The DB-level
  // partial unique index on `watchers (instrument_id) WHERE deleted_at IS
  // NULL` is the actual safety net; the route returns 409 with the existing
  // watcher id so the CLI can point the operator at the deregister flow.
  it("POST /api/v1/watchers/register rejects when active watcher exists for instrument", async () => {
    const res = await api("/api/v1/watchers/register", {
      method: "POST",
      token,
      body: {
        instrument_id: instrumentId,
        hostname: "lab-pc-02",
      },
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.details?.existing_watcher_id).toBe(watcherId);
  });

  it("POST /api/v1/watchers/register allows registration for a different instrument", async () => {
    const otherInstrumentId = "watcher-test-instrument-other";
    const db = getTestDb();
    await db.insert(instruments).values({
      id: otherInstrumentId,
      displayName: "Watcher Test Instrument (Other)",
      status: "active",
    });

    const res = await api("/api/v1/watchers/register", {
      method: "POST",
      token,
      body: {
        instrument_id: otherInstrumentId,
        hostname: "lab-pc-other",
      },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.watcher_id).toBeTruthy();
    expect(data.watcher_id).not.toBe(watcherId);
  });

  it("POST /api/v1/watchers/register rejects missing instrument_id", async () => {
    const res = await api("/api/v1/watchers/register", {
      method: "POST",
      token,
      body: {},
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/v1/watchers/register rejects nonexistent instrument", async () => {
    const res = await api("/api/v1/watchers/register", {
      method: "POST",
      token,
      body: { instrument_id: "nonexistent" },
    });
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/watchers
  // -------------------------------------------------------------------------

  it("GET /api/v1/watchers lists watchers", async () => {
    const res = await api("/api/v1/watchers", { token });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const watcher = body.data.find((w: { id: string }) => w.id === watcherId);
    expect(watcher).toBeTruthy();
    expect(watcher.instrument_id).toBe(instrumentId);
    expect(watcher.hostname).toBe("lab-pc-01");
    watcherListResponse.parse(body);
  });

  it("GET /api/v1/watchers filters by instrument_id", async () => {
    const res = await api(`/api/v1/watchers?instrument_id=${instrumentId}`, {
      token,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const w of body.data) {
      expect(w.instrument_id).toBe(instrumentId);
    }
  });

  it("GET /api/v1/watchers filters by status", async () => {
    const res = await api("/api/v1/watchers?status=registered", { token });
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const w of body.data) {
      expect(w.status).toBe("registered");
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/watchers/:watcherId
  // -------------------------------------------------------------------------

  it("GET /api/v1/watchers/:id returns watcher detail", async () => {
    const res = await api(`/api/v1/watchers/${watcherId}`, { token });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(watcherId);
    expect(data.instrument_id).toBe(instrumentId);
    expect(data.hostname).toBe("lab-pc-01");
    expect(data.os_info).toBe("Windows 11");
    watcherDetail.parse(data);
  });

  it("GET /api/v1/watchers/:id returns 404 for nonexistent watcher", async () => {
    const res = await api(
      "/api/v1/watchers/00000000-0000-0000-0000-000000000000",
      {
        token,
      }
    );
    expect(res.status).toBe(404);
  });

  it("GET /api/v1/watchers/:id returns 400 for invalid UUID", async () => {
    const res = await api("/api/v1/watchers/not-a-uuid", { token });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/watchers/:watcherId/heartbeat
  // -------------------------------------------------------------------------

  // Heartbeats serve two purposes: (1) append to the heartbeat history log
  // for auditing, and (2) update the watcher's denormalized last_heartbeat_at
  // so staleness can be computed without scanning the heartbeats table.
  it("POST /api/v1/watchers/:id/heartbeat records a heartbeat", async () => {
    const res = await api(`/api/v1/watchers/${watcherId}/heartbeat`, {
      method: "POST",
      token,
      body: {
        status: "watching",
        timestamp: new Date().toISOString(),
        upload_mode: "auto",
        files_uploaded_since_last_heartbeat: 3,
        uptime_seconds: 120,
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    watcherHeartbeatAck.parse(data);
  });

  it("POST /api/v1/watchers/:id/heartbeat rejects missing status", async () => {
    const res = await api(`/api/v1/watchers/${watcherId}/heartbeat`, {
      method: "POST",
      token,
      body: { timestamp: new Date().toISOString() },
    });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/watchers/:watcherId/heartbeats
  // -------------------------------------------------------------------------

  it("GET /api/v1/watchers/:id/heartbeats returns heartbeat history", async () => {
    const res = await api(`/api/v1/watchers/${watcherId}/heartbeats`, {
      token,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    expect(body.data[0].status).toBe("watching");
    watcherHeartbeatsListResponse.parse(body);
  });

  // -------------------------------------------------------------------------
  // POST /api/v1/watchers/:watcherId/events
  // -------------------------------------------------------------------------

  // Events are batch-inserted (up to 100 per request) to reduce round trips
  // from the watcher CLI, which buffers events between heartbeat intervals.
  it("POST /api/v1/watchers/:id/events records events", async () => {
    const res = await api(`/api/v1/watchers/${watcherId}/events`, {
      method: "POST",
      token,
      body: {
        events: [
          {
            event_type: "watcher_started",
            timestamp: new Date().toISOString(),
            message: "Watcher started successfully",
          },
          {
            event_type: "file_uploaded",
            timestamp: new Date().toISOString(),
            message: "Uploaded data_file.csv",
            details: { filename: "data_file.csv" },
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.received).toBe(2);
    watcherEventCreated.parse(data);
  });

  it("POST /api/v1/watchers/:id/events rejects empty events array", async () => {
    const res = await api(`/api/v1/watchers/${watcherId}/events`, {
      method: "POST",
      token,
      body: { events: [] },
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/v1/watchers/:id/events rejects invalid event_type", async () => {
    const res = await api(`/api/v1/watchers/${watcherId}/events`, {
      method: "POST",
      token,
      body: {
        events: [
          {
            event_type: "invalid_type",
            timestamp: new Date().toISOString(),
            message: "Test",
          },
        ],
      },
    });
    expect(res.status).toBe(400);
  });

  // Regression: the auto-update lifecycle event types are defined on the
  // Drizzle enum but a hand-maintained allow-list in the route handler
  // used to omit them, so the watcher's batched flush would 400 and drop
  // the entire batch. Exercising one of each new type here keeps the
  // handler honest if the enum grows again.
  it("POST /api/v1/watchers/:id/events accepts auto-update lifecycle events", async () => {
    const res = await api(`/api/v1/watchers/${watcherId}/events`, {
      method: "POST",
      token,
      body: {
        events: [
          {
            event_type: "update_started",
            timestamp: new Date().toISOString(),
            message: "Upgrading watcher 0.1.0 -> 0.3.0",
            details: { current_version: "0.1.0", target_version: "0.3.0" },
          },
          {
            event_type: "update_succeeded",
            timestamp: new Date().toISOString(),
            message: "Restarted into watcher 0.3.0",
          },
          {
            event_type: "update_failed",
            timestamp: new Date().toISOString(),
            message: "Watcher upgrade to 0.3.0 failed: subprocess exited 1",
            details: { reason: "subprocess exited 1" },
          },
        ],
      },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.received).toBe(3);
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/watchers/:watcherId/events
  // -------------------------------------------------------------------------

  it("GET /api/v1/watchers/:id/events returns event history", async () => {
    const res = await api(`/api/v1/watchers/${watcherId}/events`, { token });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    watcherEventsListResponse.parse(body);
  });

  it("GET /api/v1/watchers/:id/events filters by event_type", async () => {
    const res = await api(
      `/api/v1/watchers/${watcherId}/events?event_type=file_uploaded`,
      { token }
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const evt of body.data) {
      expect(evt.event_type).toBe("file_uploaded");
    }
  });

  // -------------------------------------------------------------------------
  // PUT /api/v1/watchers/:watcherId/config
  // -------------------------------------------------------------------------

  // The watcher pushes its config YAML and a SHA-256 checksum on startup.
  // The checksum is later used by the watcher to poll for config drift
  // without downloading the full YAML on every heartbeat.
  it("PUT /api/v1/watchers/:id/config stores config", async () => {
    const res = await api(`/api/v1/watchers/${watcherId}/config`, {
      method: "PUT",
      token,
      body: {
        config_checksum: "abc123",
        config_yaml: "watch_dir: /data\nupload_mode: auto\n",
      },
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.config_checksum).toBe("abc123");
    watcherChecksumResponse.parse(data);
  });

  it("PUT /api/v1/watchers/:id/config rejects missing fields", async () => {
    const res = await api(`/api/v1/watchers/${watcherId}/config`, {
      method: "PUT",
      token,
      body: { config_checksum: "abc123" },
    });
    expect(res.status).toBe(400);
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/watchers/:watcherId/config-checksum
  // -------------------------------------------------------------------------

  it("GET /api/v1/watchers/:id/config-checksum returns the stored checksum", async () => {
    const res = await api(`/api/v1/watchers/${watcherId}/config-checksum`, {
      token,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.config_checksum).toBe("abc123");
    watcherChecksumResponse.parse(data);
  });

  // -------------------------------------------------------------------------
  // GET /api/v1/watchers/:watcherId/update-check
  // -------------------------------------------------------------------------

  // Update-check is the foundation for the auto-update flow. The exact
  // response values come from the `watcher_release_config` singleton row
  // seeded in `tests/integration/global-setup.ts` so the assertions stay
  // stable as the real release line moves on.
  it("GET /api/v1/watchers/:id/update-check returns server-reported release info", async () => {
    const res = await api(`/api/v1/watchers/${watcherId}/update-check`, {
      token,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({
      latest_version: "9.9.9",
      min_supported_version: "0.1.0",
      mandatory: false,
    });
    watcherUpdateCheckResponse.parse(data);
  });

  it("GET /api/v1/watchers/:id/update-check requires authentication", async () => {
    const res = await api(`/api/v1/watchers/${watcherId}/update-check`);
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/watchers/:id/update-check rejects invalid UUID", async () => {
    const res = await api("/api/v1/watchers/not-a-uuid/update-check", {
      token,
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/v1/watchers/:id/update-check returns 404 for unknown watcher", async () => {
    const res = await api(
      "/api/v1/watchers/00000000-0000-0000-0000-000000000000/update-check",
      { token }
    );
    expect(res.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // DELETE /api/v1/watchers/:watcherId
  // -------------------------------------------------------------------------

  it("DELETE /api/v1/watchers/:id returns 403 without watchers:admin scope", async () => {
    const { token: readOnlyToken } = await seedTestUser({
      scopes: ["watchers:read"],
    });

    const res = await api(`/api/v1/watchers/${watcherId}`, {
      method: "DELETE",
      token: readOnlyToken,
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toMatch(
      /missing required scope: watchers:admin/
    );
  });

  // Watchers are soft-deleted (deleted_at set) rather than physically removed,
  // preserving the audit trail of heartbeats and events for debugging.
  it("DELETE /api/v1/watchers/:id soft-deletes the watcher", async () => {
    const res = await api(`/api/v1/watchers/${watcherId}`, {
      method: "DELETE",
      token,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.id).toBe(watcherId);
    expect(data.deleted_at).toBeTruthy();
    watcherDeleted.parse(data);
  });

  it("DELETE /api/v1/watchers/:id returns 409 for already-deleted watcher", async () => {
    const res = await api(`/api/v1/watchers/${watcherId}`, {
      method: "DELETE",
      token,
    });
    expect(res.status).toBe(409);
  });

  it("GET /api/v1/watchers/:id/update-check returns 404 for soft-deleted watcher", async () => {
    const res = await api(`/api/v1/watchers/${watcherId}/update-check`, {
      token,
    });
    expect(res.status).toBe(404);
  });

  it("GET /api/v1/watchers excludes deleted watchers by default", async () => {
    const res = await api("/api/v1/watchers", { token });
    expect(res.status).toBe(200);
    const body = await res.json();
    const found = body.data.find((w: { id: string }) => w.id === watcherId);
    expect(found).toBeFalsy();
  });

  it("GET /api/v1/watchers?include_deleted=true includes deleted watchers", async () => {
    const res = await api("/api/v1/watchers?include_deleted=true", { token });
    expect(res.status).toBe(200);
    const body = await res.json();
    const found = body.data.find((w: { id: string }) => w.id === watcherId);
    expect(found).toBeTruthy();
    expect(found.deleted_at).toBeTruthy();
  });

  // Round-trip: once the original watcher is deregistered, the partial
  // unique index permits a fresh registration for the same instrument.
  it("POST /api/v1/watchers/register succeeds again after the previous watcher is deregistered", async () => {
    const res = await api("/api/v1/watchers/register", {
      method: "POST",
      token,
      body: {
        instrument_id: instrumentId,
        hostname: "lab-pc-replacement",
      },
    });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.watcher_id).toBeTruthy();
    expect(data.watcher_id).not.toBe(watcherId);
  });
});

// ---------------------------------------------------------------------------
// The status a watcher shows
// ---------------------------------------------------------------------------

type ShownStatus = "registered" | "watching" | "stopped" | "waiting" | "stale";

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

// One watcher per case, each on an instrument of its own. The case sends the
// heartbeat (none for `registered`), and the test then sets `last_heartbeat_at`
// to `ageMs` ago, or to NULL, the way a watcher that went quiet looks. The
// ages keep a minute away from the 5-minute and 15-minute limits. A case that
// is `deregistered` is deregistered last, through the DELETE route.
interface StatusCase {
  ageMs: number | null;
  deregistered?: boolean;
  expected: ShownStatus;
  heartbeat: { status: string; status_reason?: string } | null;
  name: string;
  // What the heartbeat route stores in `status_reason`.
  storedReason: string | null;
}

const WAITING_REASON = "watch_directory not found: /data";

const STATUS_CASES: StatusCase[] = [
  {
    name: "registered, no heartbeat",
    heartbeat: null,
    ageMs: null,
    expected: "registered",
    storedReason: null,
  },
  {
    name: "registered, a day-old timestamp",
    heartbeat: null,
    ageMs: DAY_MS,
    expected: "registered",
    storedReason: null,
  },
  {
    name: "watching, fresh",
    heartbeat: { status: "watching" },
    ageMs: 4 * MINUTE_MS,
    expected: "watching",
    storedReason: null,
  },
  {
    name: "watching, six minutes",
    heartbeat: { status: "watching" },
    ageMs: 6 * MINUTE_MS,
    expected: "stale",
    storedReason: null,
  },
  {
    name: "watching, no heartbeat",
    heartbeat: { status: "watching" },
    ageMs: null,
    expected: "stale",
    storedReason: null,
  },
  {
    name: "waiting, fresh",
    heartbeat: { status: "waiting", status_reason: WAITING_REASON },
    ageMs: 4 * MINUTE_MS,
    expected: "waiting",
    storedReason: WAITING_REASON,
  },
  {
    name: "waiting, six minutes",
    heartbeat: { status: "waiting", status_reason: WAITING_REASON },
    ageMs: 6 * MINUTE_MS,
    expected: "stale",
    storedReason: WAITING_REASON,
  },
  {
    name: "stopped, fresh",
    heartbeat: { status: "stopped" },
    ageMs: MINUTE_MS,
    expected: "stopped",
    storedReason: null,
  },
  {
    name: "stopped, a day old",
    heartbeat: { status: "stopped" },
    ageMs: DAY_MS,
    expected: "stopped",
    storedReason: null,
  },
  {
    name: "stopped, no heartbeat",
    heartbeat: { status: "stopped" },
    ageMs: null,
    expected: "stopped",
    storedReason: null,
  },
  {
    name: "stopped with another reason, a day old",
    heartbeat: { status: "stopped", status_reason: "shutdown" },
    ageMs: DAY_MS,
    expected: "stopped",
    storedReason: null,
  },
  ...["system_shutdown", "auto_update"].flatMap((reason): StatusCase[] => [
    {
      name: `stopped for ${reason}, six minutes`,
      heartbeat: { status: "stopped", status_reason: reason },
      ageMs: 6 * MINUTE_MS,
      expected: "stopped",
      storedReason: reason,
    },
    {
      name: `stopped for ${reason}, fourteen minutes`,
      heartbeat: { status: "stopped", status_reason: reason },
      ageMs: 14 * MINUTE_MS,
      expected: "stopped",
      storedReason: reason,
    },
    {
      name: `stopped for ${reason}, sixteen minutes`,
      heartbeat: { status: "stopped", status_reason: reason },
      ageMs: 16 * MINUTE_MS,
      expected: "stale",
      storedReason: reason,
    },
    {
      name: `stopped for ${reason}, a day old`,
      heartbeat: { status: "stopped", status_reason: reason },
      ageMs: DAY_MS,
      expected: "stale",
      storedReason: reason,
    },
    {
      name: `stopped for ${reason}, no heartbeat`,
      heartbeat: { status: "stopped", status_reason: reason },
      ageMs: null,
      expected: "stale",
      storedReason: reason,
    },
  ]),
];

// A deregistered watcher can't send heartbeats, so it reads `stopped` whatever
// it last said. The list route shows it when `include_deleted` is true.
const DEREGISTERED_CASES: StatusCase[] = [
  {
    name: "deregistered, was registered",
    heartbeat: null,
    ageMs: null,
    expected: "stopped",
    storedReason: null,
    deregistered: true,
  },
  {
    name: "deregistered, was watching, fresh",
    heartbeat: { status: "watching" },
    ageMs: MINUTE_MS,
    expected: "stopped",
    storedReason: null,
    deregistered: true,
  },
  {
    name: "deregistered, was watching, six minutes",
    heartbeat: { status: "watching" },
    ageMs: 6 * MINUTE_MS,
    expected: "stopped",
    storedReason: null,
    deregistered: true,
  },
  {
    name: "deregistered, was watching, no heartbeat",
    heartbeat: { status: "watching" },
    ageMs: null,
    expected: "stopped",
    storedReason: null,
    deregistered: true,
  },
  {
    name: "deregistered, was waiting, six minutes",
    heartbeat: { status: "waiting", status_reason: WAITING_REASON },
    ageMs: 6 * MINUTE_MS,
    expected: "stopped",
    storedReason: WAITING_REASON,
    deregistered: true,
  },
  {
    name: "deregistered, stopped for a restart, a day old",
    heartbeat: { status: "stopped", status_reason: "system_shutdown" },
    ageMs: DAY_MS,
    expected: "stopped",
    storedReason: "system_shutdown",
    deregistered: true,
  },
];

const ALL_CASES: StatusCase[] = [...STATUS_CASES, ...DEREGISTERED_CASES];
const ACTIVE_CASES = ALL_CASES.filter((testCase) => !testCase.deregistered);

const ALL_STATUSES: ShownStatus[] = [
  "registered",
  "watching",
  "stopped",
  "waiting",
  "stale",
];

describe("Watchers API: the status a watcher shows", () => {
  let token: string;
  const idByCase = new Map<string, string>();

  async function registerWatcher(
    instrumentId: string,
    hostname: string
  ): Promise<string> {
    await getTestDb()
      .insert(instruments)
      .values({
        id: instrumentId,
        displayName: `Instrument ${instrumentId}`,
        status: "active",
      });
    const res = await api("/api/v1/watchers/register", {
      method: "POST",
      token,
      body: { instrument_id: instrumentId, hostname },
    });
    expect(res.status).toBe(201);
    return (await res.json()).watcher_id;
  }

  function sendHeartbeat(
    watcherId: string,
    body: { status: string; status_reason?: string }
  ): Promise<Response> {
    return api(`/api/v1/watchers/${watcherId}/heartbeat`, {
      method: "POST",
      token,
      body,
    });
  }

  async function ageHeartbeat(watcherId: string, ageMs: number | null) {
    await getTestDb()
      .update(watchers)
      .set({
        lastHeartbeatAt: ageMs === null ? null : new Date(Date.now() - ageMs),
      })
      .where(eq(watchers.id, watcherId));
  }

  async function storedReason(watcherId: string): Promise<string | null> {
    const [row] = await getTestDb()
      .select({ statusReason: watchers.statusReason })
      .from(watchers)
      .where(eq(watchers.id, watcherId));
    return row.statusReason;
  }

  async function listed(
    status?: string,
    includeDeleted = false
  ): Promise<Map<string, string>> {
    const params = new URLSearchParams();
    if (status) {
      params.set("status", status);
    }
    if (includeDeleted) {
      params.set("include_deleted", "true");
    }
    const query = params.size > 0 ? `?${params}` : "";
    const res = await api(`/api/v1/watchers${query}`, { token });
    expect(res.status).toBe(200);
    const body = await res.json();
    watcherListResponse.parse(body);
    return new Map(
      body.data.map((w: { id: string; status: string }) => [w.id, w.status])
    );
  }

  function idOf(name: string): string {
    const id = idByCase.get(name);
    if (!id) {
      throw new Error(`No watcher for the case '${name}'`);
    }
    return id;
  }

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    for (const [index, testCase] of ALL_CASES.entries()) {
      const id = await registerWatcher(
        `shown-status-inst-${index}`,
        `lab-pc-${index}`
      );
      idByCase.set(testCase.name, id);
      if (testCase.heartbeat) {
        const res = await sendHeartbeat(id, testCase.heartbeat);
        expect(res.status).toBe(200);
      }
      // After the heartbeat, which sets the timestamp to now.
      await ageHeartbeat(id, testCase.ageMs);
      if (testCase.deregistered) {
        const res = await api(`/api/v1/watchers/${id}`, {
          method: "DELETE",
          token,
        });
        expect(res.status).toBe(200);
      }
    }
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it.each(
    ACTIVE_CASES
  )("GET /api/v1/watchers/:id shows $expected for $name", async (testCase) => {
    const res = await api(`/api/v1/watchers/${idOf(testCase.name)}`, {
      token,
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    watcherDetail.parse(data);
    expect(data.status).toBe(testCase.expected);
    expect(data.status_reason).toBe(testCase.storedReason);
  });

  it("GET /api/v1/watchers prints the same status for each watcher", async () => {
    const shown = await listed();
    expect(shown.size).toBe(ACTIVE_CASES.length);
    for (const testCase of ACTIVE_CASES) {
      expect({
        name: testCase.name,
        status: shown.get(idOf(testCase.name)),
      }).toEqual({ name: testCase.name, status: testCase.expected });
    }
  });

  it("GET /api/v1/watchers?include_deleted=true prints a deregistered watcher as stopped", async () => {
    const shown = await listed(undefined, true);
    expect(shown.size).toBe(ALL_CASES.length);
    for (const testCase of ALL_CASES) {
      expect({
        name: testCase.name,
        status: shown.get(idOf(testCase.name)),
      }).toEqual({ name: testCase.name, status: testCase.expected });
    }
  });

  it.each(
    ALL_STATUSES
  )("GET /api/v1/watchers?status=%s returns exactly the watchers that show it", async (status) => {
    // With and without the deregistered watchers.
    for (const includeDeleted of [false, true]) {
      const cases = includeDeleted ? ALL_CASES : ACTIVE_CASES;
      const expectedNames = cases
        .filter((testCase) => testCase.expected === status)
        .map((testCase) => testCase.name);
      // A status with no case would pass trivially.
      expect(expectedNames.length).toBeGreaterThan(0);

      const shown = await listed(status, includeDeleted);
      const shownNames = cases
        .filter((testCase) => shown.has(idOf(testCase.name)))
        .map((testCase) => testCase.name);
      expect(shownNames.sort()).toEqual(expectedNames.sort());
      expect(shown.size).toBe(expectedNames.length);
      for (const printed of shown.values()) {
        expect(printed).toBe(status);
      }
    }
  });

  it("lists every watcher under exactly one status filter", async () => {
    for (const includeDeleted of [false, true]) {
      const appearances = new Map<string, number>();
      for (const status of ALL_STATUSES) {
        for (const id of (await listed(status, includeDeleted)).keys()) {
          appearances.set(id, (appearances.get(id) ?? 0) + 1);
        }
      }
      const cases = includeDeleted ? ALL_CASES : ACTIVE_CASES;
      expect(appearances.size).toBe(cases.length);
      expect([...appearances.values()].every((n) => n === 1)).toBe(true);
    }
  });

  it("never lists a deregistered watcher under stale", async () => {
    const stale = await listed("stale", true);
    for (const testCase of DEREGISTERED_CASES) {
      expect(stale.has(idOf(testCase.name))).toBe(false);
    }
  });

  it("GET /api/v1/watchers rejects a status it doesn't know", async () => {
    const res = await api("/api/v1/watchers?status=online", { token });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("combines the status filter with instrument_id", async () => {
    const id = idOf("stopped for auto_update, sixteen minutes");
    const own = await api(`/api/v1/watchers/${id}`, { token });
    const { instrument_id: instrumentId } = await own.json();

    const res = await api(
      `/api/v1/watchers?status=stale&instrument_id=${instrumentId}`,
      { token }
    );
    const body = await res.json();
    expect(body.data.map((w: { id: string }) => w.id)).toEqual([id]);

    const none = await api(
      `/api/v1/watchers?status=stopped&instrument_id=${instrumentId}`,
      { token }
    );
    expect((await none.json()).data).toEqual([]);
  });

  // The heartbeat route keeps a reason for a waiting watcher and for a watcher
  // that stopped for a restart, and clears it for everything else.
  describe("the reason a heartbeat stores", () => {
    let watcherId: string;

    beforeAll(async () => {
      watcherId = await registerWatcher(
        "stored-reason-inst",
        "lab-pc-stored-reason"
      );
    });

    it.each<[string, string, string | undefined, string | null]>([
      ["waiting keeps its reason", "waiting", WAITING_REASON, WAITING_REASON],
      [
        "a stop for a Windows restart keeps it",
        "stopped",
        "system_shutdown",
        "system_shutdown",
      ],
      [
        "a stop for an update keeps it",
        "stopped",
        "auto_update",
        "auto_update",
      ],
      ["the reason is trimmed", "stopped", "  auto_update  ", "auto_update"],
      ["a stop with no reason stores none", "stopped", undefined, null],
      ["a stop with another reason stores none", "stopped", "shutdown", null],
      [
        "a stop with a waiting reason stores none",
        "stopped",
        WAITING_REASON,
        null,
      ],
      [
        "watching with a restart reason stores none",
        "watching",
        "system_shutdown",
        null,
      ],
      [
        "registered with a restart reason stores none",
        "registered",
        "auto_update",
        null,
      ],
    ])("%s", async (_name, status, reason, expected) => {
      // Set a reason first, so a null below is a reason cleared.
      const set = await sendHeartbeat(watcherId, {
        status: "stopped",
        status_reason: "system_shutdown",
      });
      expect(set.status).toBe(200);
      expect(await storedReason(watcherId)).toBe("system_shutdown");

      const res = await sendHeartbeat(watcherId, {
        status,
        ...(reason === undefined ? {} : { status_reason: reason }),
      });
      expect(res.status).toBe(200);
      expect(await storedReason(watcherId)).toBe(expected);
    });

    it("clears the reason when the watcher starts again", async () => {
      for (const reason of ["system_shutdown", "auto_update"]) {
        await sendHeartbeat(watcherId, {
          status: "stopped",
          status_reason: reason,
        });
        expect(await storedReason(watcherId)).toBe(reason);
        // The watcher's first heartbeat after any start is `watching` or
        // `waiting`.
        await sendHeartbeat(watcherId, { status: "watching" });
        expect(await storedReason(watcherId)).toBeNull();
      }
    });

    it("moves a watcher that is back from Unresponsive to Online", async () => {
      await sendHeartbeat(watcherId, {
        status: "stopped",
        status_reason: "system_shutdown",
      });
      await ageHeartbeat(watcherId, 16 * MINUTE_MS);
      const before = await api(`/api/v1/watchers/${watcherId}`, { token });
      expect((await before.json()).status).toBe("stale");

      await sendHeartbeat(watcherId, { status: "watching" });
      const after = await api(`/api/v1/watchers/${watcherId}`, { token });
      const data = await after.json();
      expect(data.status).toBe("watching");
      expect(data.status_reason).toBeNull();
    });
  });
});
