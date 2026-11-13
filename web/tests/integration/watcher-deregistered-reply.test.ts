import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  instruments,
  personalAccessTokens,
  watcherHeartbeats,
  watchers,
} from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// A watcher stops for good when Data Hub tells it that its registration was
// deleted: a 404 whose error code is `WATCHER_DEREGISTERED`. A row that does
// not exist keeps `NOT_FOUND`, so a database restored to an older point can't
// stop every watcher. Only the heartbeat route and `GET /watchers/{id}` make
// the difference, and the heartbeat route tells only a caller that may act for
// the watcher.

const WATCHER_SCOPES = ["watchers:report", "watchers:read"] as const;
const NEVER_REGISTERED = "00000000-0000-4000-8000-000000000000";

interface Reply {
  error: { code: string; message: string };
}

describe("The 404 for a deregistered watcher", () => {
  let ownerToken: string;
  let ownerTokenId: string;
  let otherToken: string;
  let otherTokenId: string;
  let adminToken: string;
  let activeWatcherId: string;

  async function registerWatcher(
    instrumentId: string,
    token: string
  ): Promise<string> {
    await getTestDb()
      .insert(instruments)
      .values({
        id: instrumentId,
        displayName: `Deregistered ${instrumentId}`,
        status: "active",
      })
      .onConflictDoNothing();
    const res = await api("/api/v1/watchers/register", {
      method: "POST",
      token,
      body: { instrument_id: instrumentId, hostname: "lab-pc" },
    });
    expect(res.status).toBe(201);
    return (await res.json()).watcher_id;
  }

  async function deregister(watcherId: string) {
    const res = await api(`/api/v1/watchers/${watcherId}`, {
      method: "DELETE",
      token: adminToken,
    });
    expect(res.status).toBe(200);
  }

  function heartbeat(watcherId: string, token: string) {
    return api(`/api/v1/watchers/${watcherId}/heartbeat`, {
      method: "POST",
      token,
      body: { status: "watching" },
    });
  }

  async function heartbeatCount(watcherId: string): Promise<number> {
    const rows = await getTestDb()
      .select({ id: watcherHeartbeats.id })
      .from(watcherHeartbeats)
      .where(eq(watcherHeartbeats.watcherId, watcherId));
    return rows.length;
  }

  async function registeredByToken(watcherId: string) {
    const [row] = await getTestDb()
      .select({ registeredByToken: watchers.registeredByToken })
      .from(watchers)
      .where(eq(watchers.id, watcherId));
    return row?.registeredByToken;
  }

  beforeAll(async () => {
    await resetDb();
    ({ token: ownerToken, tokenId: ownerTokenId } = await seedTestUser({
      scopes: [...WATCHER_SCOPES],
    }));
    ({ token: otherToken, tokenId: otherTokenId } = await seedTestUser({
      scopes: [...WATCHER_SCOPES],
    }));
    ({ token: adminToken } = await seedTestUser({
      scopes: [...WATCHER_SCOPES, "watchers:admin"],
    }));
    activeWatcherId = await registerWatcher("deregistered-active", ownerToken);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  describe("POST /watchers/{id}/heartbeat", () => {
    it("tells the watcher's own token that it was deregistered", async () => {
      const watcherId = await registerWatcher("deregistered-own", ownerToken);
      expect((await heartbeat(watcherId, ownerToken)).status).toBe(200);
      await deregister(watcherId);
      const before = await heartbeatCount(watcherId);

      const res = await heartbeat(watcherId, ownerToken);

      expect(res.status).toBe(404);
      const body = (await res.json()) as Reply;
      expect(body.error.code).toBe("WATCHER_DEREGISTERED");
      expect(body.error.message).toBe(
        `Watcher '${watcherId}' was deregistered`
      );
      // Nothing is recorded for a deregistered watcher.
      expect(await heartbeatCount(watcherId)).toBe(before);
    });

    it("tells it for a watcher that was soft-deleted in the database too", async () => {
      const watcherId = await registerWatcher("deregistered-sql", ownerToken);
      await getTestDb()
        .update(watchers)
        .set({ deletedAt: new Date() })
        .where(eq(watchers.id, watcherId));

      const res = await heartbeat(watcherId, ownerToken);

      expect(res.status).toBe(404);
      expect(((await res.json()) as Reply).error.code).toBe(
        "WATCHER_DEREGISTERED"
      );
    });

    it("keeps NOT_FOUND for a watcher ID that was never registered", async () => {
      const res = await heartbeat(NEVER_REGISTERED, ownerToken);

      expect(res.status).toBe(404);
      const body = (await res.json()) as Reply;
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.message).toBe(
        `Watcher '${NEVER_REGISTERED}' not found`
      );
    });

    it("gives a token bound to another watcher NOT_FOUND, the reply of a watcher that does not exist", async () => {
      const watcherId = await registerWatcher("deregistered-bound", ownerToken);
      await deregister(watcherId);

      const res = await heartbeat(watcherId, otherToken);

      expect(res.status).toBe(404);
      const body = (await res.json()) as Reply;
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.message).toBe(`Watcher '${watcherId}' not found`);
      expect(await registeredByToken(watcherId)).toBe(ownerTokenId);
    });

    it("tells a token that could claim an unbound watcher, without claiming it", async () => {
      const watcherId = await registerWatcher(
        "deregistered-unbound",
        ownerToken
      );
      await getTestDb()
        .update(watchers)
        .set({ registeredByToken: null })
        .where(eq(watchers.id, watcherId));
      await deregister(watcherId);

      const res = await heartbeat(watcherId, otherToken);

      expect(res.status).toBe(404);
      expect(((await res.json()) as Reply).error.code).toBe(
        "WATCHER_DEREGISTERED"
      );
      // A deregistered row is never claimed.
      expect(await registeredByToken(watcherId)).toBeNull();
    });

    it("tells a token that could take over a binding to a revoked token", async () => {
      const { token: revokedOwnerToken, tokenId: revokedOwnerId } =
        await seedTestUser({ scopes: [...WATCHER_SCOPES] });
      const watcherId = await registerWatcher(
        "deregistered-revoked",
        revokedOwnerToken
      );
      await deregister(watcherId);
      // Set `revoked_at` directly, so the binding stays in place.
      await getTestDb()
        .update(personalAccessTokens)
        .set({ revokedAt: new Date() })
        .where(eq(personalAccessTokens.id, revokedOwnerId));

      const res = await heartbeat(watcherId, otherToken);

      expect(res.status).toBe(404);
      expect(((await res.json()) as Reply).error.code).toBe(
        "WATCHER_DEREGISTERED"
      );
      expect(await registeredByToken(watcherId)).toBe(revokedOwnerId);
    });

    it("still answers 403 to another token for an active watcher", async () => {
      const res = await heartbeat(activeWatcherId, otherToken);

      expect(res.status).toBe(403);
      expect(((await res.json()) as Reply).error.code).toBe("FORBIDDEN");
      expect(await registeredByToken(activeWatcherId)).toBe(ownerTokenId);
      expect(otherTokenId).not.toBe(ownerTokenId);
    });

    it("still answers an active watcher's own token with 200", async () => {
      const res = await heartbeat(activeWatcherId, ownerToken);

      expect(res.status).toBe(200);
    });
  });

  describe("GET /watchers/{id}", () => {
    it("tells a caller that the watcher was deregistered", async () => {
      const watcherId = await registerWatcher("deregistered-get", ownerToken);
      await deregister(watcherId);

      const res = await api(`/api/v1/watchers/${watcherId}`, {
        token: ownerToken,
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as Reply;
      expect(body.error.code).toBe("WATCHER_DEREGISTERED");
      expect(body.error.message).toBe(
        `Watcher '${watcherId}' was deregistered`
      );
    });

    it("tells another token with the scope, which sees the same watcher in the list", async () => {
      const watcherId = await registerWatcher(
        "deregistered-get-other",
        ownerToken
      );
      await deregister(watcherId);

      const res = await api(`/api/v1/watchers/${watcherId}`, {
        token: otherToken,
      });
      const list = await api("/api/v1/watchers?include_deleted=true", {
        token: otherToken,
      });

      expect(res.status).toBe(404);
      expect(((await res.json()) as Reply).error.code).toBe(
        "WATCHER_DEREGISTERED"
      );
      const { data } = (await list.json()) as {
        data: { id: string; deleted_at: string | null }[];
      };
      expect(data.find((w) => w.id === watcherId)?.deleted_at).toBeTruthy();
    });

    it("keeps NOT_FOUND for a watcher ID that was never registered", async () => {
      const res = await api(`/api/v1/watchers/${NEVER_REGISTERED}`, {
        token: ownerToken,
      });

      expect(res.status).toBe(404);
      const body = (await res.json()) as Reply;
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.error.message).toBe(
        `Watcher '${NEVER_REGISTERED}' not found`
      );
    });

    it("refuses a token without watchers:read before it says anything about the watcher", async () => {
      const watcherId = await registerWatcher(
        "deregistered-get-scope",
        ownerToken
      );
      await deregister(watcherId);
      const { token: noReadToken } = await seedTestUser({
        scopes: ["watchers:report"],
      });

      const res = await api(`/api/v1/watchers/${watcherId}`, {
        token: noReadToken,
      });

      expect(res.status).toBe(403);
      expect(((await res.json()) as Reply).error.code).toBe("FORBIDDEN");
    });

    it("still returns an active watcher", async () => {
      const res = await api(`/api/v1/watchers/${activeWatcherId}`, {
        token: ownerToken,
      });

      expect(res.status).toBe(200);
      expect((await res.json()).id).toBe(activeWatcherId);
    });
  });

  describe("the other watcher routes", () => {
    it("keep NOT_FOUND for a deregistered watcher", async () => {
      const watcherId = await registerWatcher("deregistered-other", ownerToken);
      await deregister(watcherId);

      for (const path of ["upload-queue", "update-check", "config-checksum"]) {
        const res = await api(`/api/v1/watchers/${watcherId}/${path}`, {
          token: ownerToken,
        });
        expect(res.status, path).toBe(404);
        expect(((await res.json()) as Reply).error.code, path).toBe(
          "NOT_FOUND"
        );
      }
    });
  });
});
