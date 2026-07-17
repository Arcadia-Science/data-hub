import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { instruments, watchers } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// Cross-control IDOR guard: a watchers:report (or :read) PAT may only
// operate on the watcher it registered. Bound endpoints are exercised
// parametrically so none regress. Session exemption is covered by the
// unit suite (`decideWatcherBinding`) — this harness has no cookies.

const WATCHER_SCOPES = [
  "watchers:report",
  "watchers:read",
  "instruments:read",
  "instruments:write",
] as const;

describe("Watcher PAT binding", () => {
  let tokenA: string;
  let tokenIdA: string;
  let tokenB: string;
  let watcherAId: string;
  let watcherBId: string;

  beforeAll(async () => {
    await resetDb();
    ({ token: tokenA, tokenId: tokenIdA } = await seedTestUser({
      scopes: [...WATCHER_SCOPES],
    }));
    ({ token: tokenB } = await seedTestUser({
      scopes: [...WATCHER_SCOPES],
    }));

    const db = getTestDb();
    await db.insert(instruments).values([
      {
        id: "binding-instr-a",
        displayName: "Binding Instrument A",
        status: "active",
      },
      {
        id: "binding-instr-b",
        displayName: "Binding Instrument B",
        status: "active",
      },
    ]);

    const regA = await api("/api/v1/watchers/register", {
      method: "POST",
      token: tokenA,
      body: {
        instrument_id: "binding-instr-a",
        hostname: "pc-a",
      },
    });
    expect(regA.status).toBe(201);
    watcherAId = (await regA.json()).watcher_id;

    const regB = await api("/api/v1/watchers/register", {
      method: "POST",
      token: tokenB,
      body: {
        instrument_id: "binding-instr-b",
        hostname: "pc-b",
      },
    });
    expect(regB.status).toBe(201);
    watcherBId = (await regB.json()).watcher_id;

    // Config push seeds a checksum so the config-checksum GET can return 200
    // for the owner token (404 "no config" would mask a binding failure).
    const cfgRes = await api(`/api/v1/watchers/${watcherAId}/config`, {
      method: "PUT",
      token: tokenA,
      body: {
        config_yaml: "instrument:\n  watch_directory: /tmp/a\n",
        config_checksum: "checksum-a",
      },
    });
    expect(cfgRes.status).toBe(200);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("POST /watchers/register records registered_by_token for the PAT", async () => {
    const db = getTestDb();
    const [row] = await db
      .select({ registeredByToken: watchers.registeredByToken })
      .from(watchers)
      .where(eq(watchers.id, watcherAId))
      .limit(1);
    expect(row?.registeredByToken).toBe(tokenIdA);
  });

  // Parametrized across the full watcher-operational surface so a future
  // endpoint can't silently skip enforceWatcherBinding.
  const boundCases: {
    name: string;
    method: "GET" | "POST" | "PUT";
    path: (id: string) => string;
    body?: unknown;
    ownStatus: number;
  }[] = [
    {
      name: "heartbeat",
      method: "POST",
      path: (id) => `/api/v1/watchers/${id}/heartbeat`,
      body: { status: "watching" },
      ownStatus: 200,
    },
    {
      name: "config",
      method: "PUT",
      path: (id) => `/api/v1/watchers/${id}/config`,
      body: {
        config_yaml: "instrument:\n  watch_directory: /tmp/cross\n",
        config_checksum: "checksum-cross",
      },
      ownStatus: 200,
    },
    {
      name: "events",
      method: "POST",
      path: (id) => `/api/v1/watchers/${id}/events`,
      body: {
        events: [
          {
            event_type: "watcher_started",
            timestamp: new Date().toISOString(),
            message: "binding test",
          },
        ],
      },
      ownStatus: 201,
    },
    {
      name: "config-checksum",
      method: "GET",
      path: (id) => `/api/v1/watchers/${id}/config-checksum`,
      ownStatus: 200,
    },
    {
      name: "upload-queue",
      method: "GET",
      path: (id) => `/api/v1/watchers/${id}/upload-queue`,
      ownStatus: 200,
    },
    {
      name: "update-check",
      method: "GET",
      path: (id) => `/api/v1/watchers/${id}/update-check`,
      ownStatus: 200,
    },
  ];

  for (const c of boundCases) {
    it(`${c.name}: own token succeeds`, async () => {
      const res = await api(c.path(watcherAId), {
        method: c.method,
        token: tokenA,
        body: c.body,
      });
      expect(res.status).toBe(c.ownStatus);
    });

    it(`${c.name}: cross-token is forbidden`, async () => {
      const res = await api(c.path(watcherAId), {
        method: c.method,
        token: tokenB,
        body: c.body,
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toMatch(/not authorized for this watcher/);
    });
  }

  // Reciprocal: token A cannot drive watcher B either.
  it("heartbeat: token A cannot drive watcher B", async () => {
    const res = await api(`/api/v1/watchers/${watcherBId}/heartbeat`, {
      method: "POST",
      token: tokenA,
      body: { status: "stopped" },
    });
    expect(res.status).toBe(403);
  });

  describe("TOFU claim on null binding", () => {
    const tofuInstrumentId = "binding-instr-tofu";
    let tofuWatcherId: string;

    beforeEach(async () => {
      await resetDb();
      ({ token: tokenA, tokenId: tokenIdA } = await seedTestUser({
        scopes: [...WATCHER_SCOPES],
      }));
      ({ token: tokenB } = await seedTestUser({
        scopes: [...WATCHER_SCOPES],
      }));

      const db = getTestDb();
      await db.insert(instruments).values({
        id: tofuInstrumentId,
        displayName: "TOFU Instrument",
        status: "active",
      });

      // Pre-binding row: insert directly with null registered_by_token to
      // simulate a watcher that existed before the binding column.
      const [row] = await db
        .insert(watchers)
        .values({
          instrumentId: tofuInstrumentId,
          hostname: "tofu-pc",
          status: "registered",
          registeredByToken: null,
        })
        .returning({ id: watchers.id });
      tofuWatcherId = row.id;
    });

    it("first token claims the null binding; second is denied", async () => {
      const claim = await api(`/api/v1/watchers/${tofuWatcherId}/heartbeat`, {
        method: "POST",
        token: tokenA,
        body: { status: "watching" },
      });
      expect(claim.status).toBe(200);

      const db = getTestDb();
      const [bound] = await db
        .select({ registeredByToken: watchers.registeredByToken })
        .from(watchers)
        .where(eq(watchers.id, tofuWatcherId))
        .limit(1);
      expect(bound?.registeredByToken).toBe(tokenIdA);

      const denied = await api(`/api/v1/watchers/${tofuWatcherId}/heartbeat`, {
        method: "POST",
        token: tokenB,
        body: { status: "stopped" },
      });
      expect(denied.status).toBe(403);

      // Claimant can keep operating.
      const again = await api(`/api/v1/watchers/${tofuWatcherId}/heartbeat`, {
        method: "POST",
        token: tokenA,
        body: { status: "watching" },
      });
      expect(again.status).toBe(200);
    });
  });
});
