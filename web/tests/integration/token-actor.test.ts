import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getInstrumentById } from "@/lib/api/instruments";
import { listNotifications } from "@/lib/api/notifications";
import { getWatcherById } from "@/lib/api/watchers";
import {
  instrumentRuns,
  instruments,
  notifications,
  personalAccessTokens,
  runAttributions,
  watchers,
} from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedSessionCookie,
  seedTestUser,
} from "@/tests/integration/helpers";

// Tokens act as themselves: rows they write carry the token, never a user.
// Each audit column pairs a user column with a token column, and exactly one
// is set for any given action.

const instrumentId = "token-actor-instrument";

async function seedInstrument(status: "active" | "inactive" = "active") {
  await getTestDb().insert(instruments).values({
    id: instrumentId,
    displayName: "Token Actor Instrument",
    status,
  });
}

async function seedWatcher() {
  const [row] = await getTestDb()
    .insert(watchers)
    .values({ instrumentId, hostname: "actor-pc", status: "watching" })
    .returning({ id: watchers.id });
  return row.id;
}

describe("Token audit actors", () => {
  beforeEach(async () => {
    await resetDb();
    await seedInstrument();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("records the token that retired an instrument and its watchers", async () => {
    const bot = await seedTestUser({
      tokenName: "Retire Bot",
      scopes: ["instruments:write", "instruments:read"],
    });
    const watcherId = await seedWatcher();

    const res = await api(`/api/v1/instruments/${instrumentId}`, {
      method: "PATCH",
      token: bot.token,
      body: { status: "inactive" },
    });
    expect(res.status).toBe(200);

    const db = getTestDb();
    const [instrument] = await db
      .select({
        retiredBy: instruments.retiredBy,
        retiredByToken: instruments.retiredByToken,
      })
      .from(instruments)
      .where(eq(instruments.id, instrumentId));
    expect(instrument).toEqual({
      retiredBy: null,
      retiredByToken: bot.tokenId,
    });

    const [watcher] = await db
      .select({
        deregisteredBy: watchers.deregisteredBy,
        deregisteredByToken: watchers.deregisteredByToken,
      })
      .from(watchers)
      .where(eq(watchers.id, watcherId));
    expect(watcher).toEqual({
      deregisteredBy: null,
      deregisteredByToken: bot.tokenId,
    });

    const detail = await getInstrumentById(instrumentId);
    expect(detail?.retiredBy).toEqual({
      kind: "token",
      token: { id: bot.tokenId, name: "Retire Bot", revoked: false },
    });
  });

  it("records the user when a person retires an instrument", async () => {
    const admin = await seedTestUser({ isAdmin: true });

    const res = await api(`/api/v1/instruments/${instrumentId}`, {
      method: "PATCH",
      headers: { Cookie: await seedSessionCookie(admin.userId) },
      body: { status: "inactive" },
    });
    expect(res.status).toBe(200);

    const [instrument] = await getTestDb()
      .select({
        retiredBy: instruments.retiredBy,
        retiredByToken: instruments.retiredByToken,
      })
      .from(instruments)
      .where(eq(instruments.id, instrumentId));
    expect(instrument).toEqual({
      retiredBy: admin.userId,
      retiredByToken: null,
    });
  });

  it("clears the retirer when the instrument is reactivated", async () => {
    const bot = await seedTestUser({
      scopes: ["instruments:write", "instruments:read"],
    });
    for (const status of ["inactive", "active"]) {
      const res = await api(`/api/v1/instruments/${instrumentId}`, {
        method: "PATCH",
        token: bot.token,
        body: { status },
      });
      expect(res.status).toBe(200);
    }

    const [instrument] = await getTestDb()
      .select({
        retiredBy: instruments.retiredBy,
        retiredByToken: instruments.retiredByToken,
      })
      .from(instruments)
      .where(eq(instruments.id, instrumentId));
    expect(instrument).toEqual({ retiredBy: null, retiredByToken: null });
  });

  it("records the token that deregistered a watcher", async () => {
    const bot = await seedTestUser({
      tokenName: "Watcher Admin Bot",
      scopes: ["watchers:admin"],
    });
    const watcherId = await seedWatcher();

    const res = await api(`/api/v1/watchers/${watcherId}`, {
      method: "DELETE",
      token: bot.token,
    });
    expect(res.status).toBe(200);

    const detail = await getWatcherById(watcherId);
    expect(detail?.deregisteredBy).toEqual({
      kind: "token",
      token: { id: bot.tokenId, name: "Watcher Admin Bot", revoked: false },
    });
  });

  it("keeps naming a token after it is revoked, and flags it", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const bot = await seedTestUser({
      tokenName: "Short-lived Bot",
      scopes: ["watchers:admin"],
    });
    const watcherId = await seedWatcher();
    await api(`/api/v1/watchers/${watcherId}`, {
      method: "DELETE",
      token: bot.token,
    });

    const revoke = await api(`/api/v1/tokens/${bot.tokenId}`, {
      method: "DELETE",
      headers: { Cookie: await seedSessionCookie(admin.userId) },
    });
    expect(revoke.status).toBe(204);

    const detail = await getWatcherById(watcherId);
    expect(detail?.deregisteredBy).toEqual({
      kind: "token",
      token: { id: bot.tokenId, name: "Short-lived Bot", revoked: true },
    });
  });

  it("notifies run attributors about a token's comment, naming the token", async () => {
    const bot = await seedTestUser({
      tokenName: "Review Bot",
      scopes: ["runs:comment"],
    });
    const runner = await seedTestUser();
    const db = getTestDb();
    const [run] = await db
      .insert(instrumentRuns)
      .values({ instrumentId, runId: "commented-run", source: "lambda" })
      .returning({ id: instrumentRuns.id });
    await db
      .insert(runAttributions)
      .values({ runId: run.id, userId: runner.userId });

    const res = await api(
      `/api/v1/instruments/${instrumentId}/runs/commented-run/comments`,
      { method: "POST", token: bot.token, body: { body: "Looks odd." } }
    );
    expect(res.status).toBe(201);

    // Fan-out runs in `after()`, so wait for the row to land.
    const deadline = Date.now() + 3000;
    let rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, runner.userId));
    while (rows.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, runner.userId));
    }
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("comment_attributed");
    expect(rows[0].actorUserId).toBeNull();
    expect(rows[0].actorTokenId).toBe(bot.tokenId);

    const [item] = await listNotifications(runner.userId);
    expect(item.actor).toBeNull();
    expect(item.actorToken?.name).toBe("Review Bot");
  });

  it("revoking a token never removes the row that audit columns reference", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const bot = await seedTestUser({ scopes: ["watchers:admin"] });
    const watcherId = await seedWatcher();
    await api(`/api/v1/watchers/${watcherId}`, {
      method: "DELETE",
      token: bot.token,
    });

    await api(`/api/v1/tokens/${bot.tokenId}`, {
      method: "DELETE",
      headers: { Cookie: await seedSessionCookie(admin.userId) },
    });

    const [row] = await getTestDb()
      .select({ id: personalAccessTokens.id })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.id, bot.tokenId));
    expect(row?.id).toBe(bot.tokenId);
  });
});
