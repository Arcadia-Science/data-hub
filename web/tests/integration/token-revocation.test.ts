import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { notifyComment } from "@/lib/api/notifications";
import {
  archiveJobs,
  instrumentRuns,
  instruments,
  notifications,
  personalAccessTokens,
  runComments,
  users,
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

const WATCHER_SCOPES = ["watchers:report", "instruments:read"];

async function sessionHeaders(userId: string) {
  return { Cookie: await seedSessionCookie(userId) };
}

async function revoke(adminUserId: string, tokenId: string) {
  return await api(`/api/v1/tokens/${tokenId}`, {
    method: "DELETE",
    headers: await sessionHeaders(adminUserId),
  });
}

describe("Token revocation", () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("keeps the row, stamps revoked_at, and stops the token working", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const member = await seedTestUser();

    const before = await api("/api/v1/instruments", { token: member.token });
    expect(before.status).toBe(200);

    const res = await revoke(admin.userId, member.tokenId);
    expect(res.status).toBe(204);

    const [row] = await getTestDb()
      .select({ revokedAt: personalAccessTokens.revokedAt })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.id, member.tokenId));
    expect(row?.revokedAt).toBeInstanceOf(Date);

    const after = await api("/api/v1/instruments", { token: member.token });
    expect(after.status).toBe(401);
  });

  it("hides revoked tokens from the token list", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const listBefore = await api("/api/v1/tokens", {
      headers: await sessionHeaders(admin.userId),
    });
    expect(
      ((await listBefore.json()) as { id: string }[]).map((t) => t.id)
    ).toContain(admin.tokenId);

    const other = await seedTestUser({ isAdmin: true });
    expect((await revoke(other.userId, admin.tokenId)).status).toBe(204);

    const listAfter = await api("/api/v1/tokens", {
      headers: await sessionHeaders(admin.userId),
    });
    expect(
      ((await listAfter.json()) as { id: string }[]).map((t) => t.id)
    ).not.toContain(admin.tokenId);
  });

  it("returns 404 when the token is already revoked", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const member = await seedTestUser();
    expect((await revoke(admin.userId, member.tokenId)).status).toBe(204);
    expect((await revoke(admin.userId, member.tokenId)).status).toBe(404);
  });

  it("rejects revocation by a non-admin", async () => {
    const member = await seedTestUser();
    const target = await seedTestUser();
    expect((await revoke(member.userId, target.tokenId)).status).toBe(403);

    const [row] = await getTestDb()
      .select({ revokedAt: personalAccessTokens.revokedAt })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.id, target.tokenId));
    expect(row?.revokedAt).toBeNull();
  });

  it("frees the watcher so a replacement token can take over", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const original = await seedTestUser({ scopes: WATCHER_SCOPES });
    const replacement = await seedTestUser({ scopes: WATCHER_SCOPES });
    const db = getTestDb();
    await db.insert(instruments).values({
      id: "revocation-instrument",
      displayName: "Revocation Instrument",
      status: "active",
    });

    const registered = await api("/api/v1/watchers/register", {
      method: "POST",
      token: original.token,
      body: { instrument_id: "revocation-instrument", hostname: "pc" },
    });
    expect(registered.status).toBe(201);
    const watcherId = (await registered.json()).watcher_id as string;

    const denied = await api(`/api/v1/watchers/${watcherId}/heartbeat`, {
      method: "POST",
      token: replacement.token,
      body: { status: "watching" },
    });
    expect(denied.status).toBe(403);

    expect((await revoke(admin.userId, original.tokenId)).status).toBe(204);

    const [freed] = await db
      .select({ registeredByToken: watchers.registeredByToken })
      .from(watchers)
      .where(eq(watchers.id, watcherId));
    expect(freed?.registeredByToken).toBeNull();

    const claimed = await api(`/api/v1/watchers/${watcherId}/heartbeat`, {
      method: "POST",
      token: replacement.token,
      body: { status: "watching" },
    });
    expect(claimed.status).toBe(200);
  });
});

describe("Token creator", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("records the admin who created a token", async () => {
    const admin = await seedTestUser({ isAdmin: true });

    const res = await api("/api/v1/tokens", {
      method: "POST",
      headers: await sessionHeaders(admin.userId),
      body: { name: "watcher-pc", scopes: ["instruments:read"] },
    });
    expect(res.status).toBe(201);
    const { id, token } = (await res.json()) as { id: string; token: string };

    const [row] = await getTestDb()
      .select({
        userId: personalAccessTokens.userId,
        createdBy: personalAccessTokens.createdBy,
      })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.id, id));
    // `user_id` is a deprecated copy of the creator, kept so a rollback to the
    // previous release still works. Nothing reads it for sign-in.
    expect(row).toEqual({ userId: admin.userId, createdBy: admin.userId });

    const use = await api("/api/v1/instruments", { token });
    expect(use.status).toBe(200);
  });

  it("rejects a user_id, since tokens no longer have an owner", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const member = await seedTestUser();

    const res = await api("/api/v1/tokens", {
      method: "POST",
      headers: await sessionHeaders(admin.userId),
      body: {
        name: "made-for-member",
        scopes: ["runs:read"],
        user_id: member.userId,
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("lists the tokens a person created", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const other = await seedTestUser({ isAdmin: true });
    const headers = await sessionHeaders(admin.userId);
    const created = await api("/api/v1/tokens", {
      method: "POST",
      headers,
      body: { name: "mine", scopes: ["runs:read"] },
    });
    const { id } = (await created.json()) as { id: string };

    const mine = await api("/api/v1/tokens", { headers });
    const mineIds = ((await mine.json()) as { id: string }[]).map((t) => t.id);
    expect(mineIds).toContain(id);

    const theirs = await api("/api/v1/tokens", {
      headers: await sessionHeaders(other.userId),
    });
    const theirIds = ((await theirs.json()) as { id: string }[]).map(
      (t) => t.id
    );
    expect(theirIds).not.toContain(id);
  });

  it("records the creator on seeded tokens", async () => {
    const member = await seedTestUser();
    const [row] = await getTestDb()
      .select({
        userId: personalAccessTokens.userId,
        createdBy: personalAccessTokens.createdBy,
      })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.id, member.tokenId));
    expect(row).toEqual({ userId: member.userId, createdBy: member.userId });
  });
});

describe("Token audit columns", () => {
  let token: string;
  let tokenId: string;
  let userId: string;
  let runId: string;

  beforeEach(async () => {
    await resetDb();
    ({ token, tokenId, userId } = await seedTestUser());
    const db = getTestDb();
    await db.insert(instruments).values({
      id: "audit-instrument",
      displayName: "Audit Instrument",
      status: "active",
    });
    const [run] = await db
      .insert(instrumentRuns)
      .values({
        instrumentId: "audit-instrument",
        runId: "audit-run",
        source: "lambda",
      })
      .returning({ id: instrumentRuns.id });
    runId = run.id;
  });

  it("allows a run to be deleted by a token", async () => {
    await getTestDb()
      .update(instrumentRuns)
      .set({ deletedAt: new Date(), deletedByToken: tokenId })
      .where(eq(instrumentRuns.id, runId));
  });

  it("rejects a run deleted by both a user and a token", async () => {
    await expect(
      getTestDb()
        .update(instrumentRuns)
        .set({ deletedBy: userId, deletedByToken: tokenId })
        .where(eq(instrumentRuns.id, runId))
    ).rejects.toThrow();
  });

  it("requires a comment to have exactly one author", async () => {
    const db = getTestDb();
    await db.insert(runComments).values({ runId, tokenId, body: "from token" });
    await db.insert(runComments).values({ runId, userId, body: "from user" });

    await expect(
      db.insert(runComments).values({ runId, body: "nobody" })
    ).rejects.toThrow();
    await expect(
      db.insert(runComments).values({ runId, userId, tokenId, body: "both" })
    ).rejects.toThrow();
  });

  // Every table that records an actor has a check constraint so one row never
  // names both a person and a token. Each case inserts the smallest valid row.
  const pairCases: {
    constraint: string;
    insert: (actor: { userId?: string; tokenId?: string }) => Promise<unknown>;
    table: string;
  }[] = [
    {
      table: "archive_jobs",
      constraint: "archive_jobs_one_creator",
      insert: ({ userId: createdBy, tokenId: createdByToken }) =>
        getTestDb().insert(archiveJobs).values({
          instrumentRunId: runId,
          fingerprint: crypto.randomUUID(),
          createdBy,
          createdByToken,
        }),
    },
    {
      table: "instruments",
      constraint: "instruments_one_retirer",
      insert: ({ userId: retiredBy, tokenId: retiredByToken }) =>
        getTestDb()
          .insert(instruments)
          .values({
            id: `retired-${crypto.randomUUID()}`,
            displayName: "Retired Instrument",
            retiredBy,
            retiredByToken,
          }),
    },
    {
      table: "notifications",
      constraint: "notifications_one_actor",
      insert: ({ userId: actorUserId, tokenId: actorTokenId }) =>
        getTestDb()
          .insert(notifications)
          .values({
            // The recipient is a separate column from the actor.
            userId: actorUserId ?? userId,
            type: "generic",
            body: "hello",
            actorUserId,
            actorTokenId,
          }),
    },
    {
      table: "watchers",
      constraint: "watchers_one_deregisterer",
      insert: ({ userId: deregisteredBy, tokenId: deregisteredByToken }) =>
        getTestDb().insert(watchers).values({
          instrumentId: "audit-instrument",
          // Soft-deleted, so rows do not collide on the one-active-watcher
          // index for the instrument.
          deletedAt: new Date(),
          deregisteredBy,
          deregisteredByToken,
        }),
    },
  ];

  for (const { table, constraint, insert } of pairCases) {
    it(`${table}: accepts a user or a token but not both`, async () => {
      await insert({ userId });
      await insert({ tokenId });
      await insert({});

      const error = await insert({ userId, tokenId }).then(
        () => null,
        (e: unknown) => e as { cause?: { constraint?: string } }
      );
      expect(error).not.toBeNull();
      // Drizzle wraps the Postgres error; the cause carries the constraint.
      expect(error?.cause?.constraint).toBe(constraint);
    });
  }

  it("refuses to hard-delete a token that audit rows point at", async () => {
    const db = getTestDb();
    await db.insert(runComments).values({ runId, tokenId, body: "from token" });
    await expect(
      db
        .delete(personalAccessTokens)
        .where(eq(personalAccessTokens.id, tokenId))
    ).rejects.toThrow();
  });

  it("still notifies other commenters when a run has a token comment", async () => {
    const db = getTestDb();
    const { userId: participant } = await seedTestUser();
    const { userId: author } = await seedTestUser();
    await db.insert(runComments).values({ runId, tokenId, body: "from token" });
    await db
      .insert(runComments)
      .values({ runId, userId: participant, body: "earlier comment" });
    const [comment] = await db
      .insert(runComments)
      .values({ runId, userId: author, body: "new comment" })
      .returning({ id: runComments.id });

    await notifyComment({
      runInternalId: runId,
      commentId: comment.id,
      author: { kind: "user", userId: author },
    });

    const rows = await db
      .select({
        userId: notifications.userId,
        type: notifications.type,
      })
      .from(notifications)
      .where(eq(notifications.runId, runId));
    expect(rows).toEqual([
      { userId: participant, type: "comment_participated" },
    ]);
  });

  // Policy: deleting a person must not break machine tokens such as the
  // Lambda or watcher token. Admins revoke a leaving person's tokens by hand.
  it("keeps a token working after its creator is deleted", async () => {
    const db = getTestDb();
    const before = await api("/api/v1/instruments", { token });
    expect(before.status).toBe(200);

    await db.delete(users).where(eq(users.id, userId));

    // The foreign keys null both person columns on the token row.
    const [row] = await db
      .select({
        userId: personalAccessTokens.userId,
        createdBy: personalAccessTokens.createdBy,
        revokedAt: personalAccessTokens.revokedAt,
      })
      .from(personalAccessTokens)
      .where(eq(personalAccessTokens.id, tokenId));
    expect(row).toEqual({ userId: null, createdBy: null, revokedAt: null });

    const after = await api("/api/v1/instruments", { token });
    expect(after.status).toBe(200);
  });
});
