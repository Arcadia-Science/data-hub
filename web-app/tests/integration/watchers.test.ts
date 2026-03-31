import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instruments } from "../../lib/db/schema";
import { api, closeTestDb, getTestDb, resetDb, seedTestUser } from "./helpers";

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
  // DELETE /api/v1/watchers/:watcherId
  // -------------------------------------------------------------------------

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
});
