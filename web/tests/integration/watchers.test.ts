import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instruments } from "@/lib/db/schema";
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
      channel: "stable",
      mandatory: false,
    });
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
