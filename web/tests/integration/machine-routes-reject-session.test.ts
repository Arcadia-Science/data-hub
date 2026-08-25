import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  api,
  closeTestDb,
  resetDb,
  seedSessionCookie,
  seedTestUser,
} from "@/tests/integration/helpers";

// Regression pin for the session-`*` bypass on machine-only routes.
// Browser logins carry every scope, so these watcher/Lambda callbacks
// must reject a session cookie and accept only a PAT.
//
// Auth is the first check on each handler, so dummy ids are enough —
// we never reach lookup.

const WATCHER_ID = "00000000-0000-0000-0000-000000000000";
const JOB_ID = "11111111-1111-1111-1111-111111111111";
const INSTRUMENT_ID = "session-reject-instrument";
const RUN_ID = "session-reject-run";

const MACHINE_ROUTES: {
  method: "GET" | "POST" | "PUT" | "PATCH";
  path: string;
  body?: unknown;
}[] = [
  {
    method: "POST",
    path: "/api/v1/watchers/register",
    body: { instrument_id: INSTRUMENT_ID },
  },
  {
    method: "POST",
    path: `/api/v1/watchers/${WATCHER_ID}/heartbeat`,
    body: { status: "stopped" },
  },
  {
    method: "PUT",
    path: `/api/v1/watchers/${WATCHER_ID}/config`,
    body: { config_yaml: "instrument: {}\n", config_checksum: "x" },
  },
  {
    method: "POST",
    path: `/api/v1/watchers/${WATCHER_ID}/events`,
    body: {
      events: [
        {
          event_type: "watcher_started",
          timestamp: new Date().toISOString(),
          message: "session reject",
        },
      ],
    },
  },
  {
    method: "GET",
    path: `/api/v1/watchers/${WATCHER_ID}/upload-queue`,
  },
  {
    method: "GET",
    path: `/api/v1/watchers/${WATCHER_ID}/config-checksum`,
  },
  {
    method: "GET",
    path: `/api/v1/watchers/${WATCHER_ID}/update-check`,
  },
  {
    method: "PATCH",
    path: "/api/v1/files/1",
    body: { status: "uploaded" },
  },
  {
    method: "POST",
    path: `/api/v1/instruments/${INSTRUMENT_ID}/runs/${RUN_ID}/request-upload-url`,
    body: { filename: "attack.csv" },
  },
  {
    method: "POST",
    path: `/api/v1/instruments/${INSTRUMENT_ID}/runs`,
    body: { run_id: RUN_ID, source: "watcher" },
  },
  {
    method: "PATCH",
    path: `/api/v1/instruments/${INSTRUMENT_ID}/runs/${RUN_ID}`,
    body: { metadata: { forged: true } },
  },
  {
    method: "PATCH",
    path: `/api/v1/archive-jobs/${JOB_ID}`,
    body: { status: "failed", error_message: "session reject" },
  },
  {
    method: "POST",
    path: "/api/v1/instruments",
    body: { id: "forged-instrument" },
  },
];

describe("Machine-only routes reject browser sessions", () => {
  let sessionCookie: string;

  beforeAll(async () => {
    await resetDb();
    const { userId } = await seedTestUser({ isAdmin: false });
    sessionCookie = await seedSessionCookie(userId);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // Confirms the cookie is a live session — otherwise a 401 on the
  // machine routes could just mean cookie synthesis is broken.
  it("GET /api/v1/instruments accepts the same session cookie", async () => {
    const res = await api("/api/v1/instruments", {
      headers: { Cookie: sessionCookie },
    });
    expect(res.status).toBe(200);
  });

  for (const c of MACHINE_ROUTES) {
    it(`${c.method} ${c.path} returns 401`, async () => {
      const res = await api(c.path, {
        method: c.method,
        headers: { Cookie: sessionCookie },
        body: c.body,
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
    });
  }
});
