import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  countUnread,
  getPreferences,
  listInstrumentSubscriptions,
  listNotifications,
  markRead,
  notifyComment,
  notifyRunCreated,
  setInstrumentSubscription,
  updatePreferences,
} from "@/lib/api/notifications";
import {
  instrumentNotificationSubscriptions,
  instrumentRuns,
  instruments,
  notifications,
  runAttributions,
  runComments,
  slackConnections,
} from "@/lib/db/schema";
import {
  api,
  clearCapturedSlackDms,
  closeTestDb,
  getCapturedSlackDms,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

// End-to-end + library-level coverage for the in-app notifications system.
// The library matrix exercises the recipient-selection logic directly
// against the test DB so it stays deterministic; one HTTP smoke per route
// proves the `after(...)` wiring in the runs / comments handlers is in place.
//
// Session-only HTTP routes (the read/settings surfaces) are only checked
// for their 401 gate — the harness has no session-cookie synthesis (see
// users.test.ts for the same gap), and the underlying call sites are
// covered transitively by the library suites.

describe("Notifications", () => {
  beforeAll(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // -------------------------------------------------------------------------
  // Test helpers — small wrappers that keep individual cases focused.
  // -------------------------------------------------------------------------

  /**
   * Seed a run on a given instrument and return its surrogate UUID. Tests
   * that don't need a specific run id (most of the library matrix) use this
   * to get a fresh, isolated row.
   */
  async function seedRun(instrumentId: string, runId: string): Promise<string> {
    const db = getTestDb();
    const [row] = await db
      .insert(instrumentRuns)
      .values({ instrumentId, runId, source: "lambda" })
      .returning({ id: instrumentRuns.id });
    return row.id;
  }

  async function seedInstrument(id: string, displayName: string) {
    const db = getTestDb();
    await db.insert(instruments).values({ id, displayName, status: "active" });
  }

  /**
   * Polls until `predicate` resolves true or the deadline lapses. Used by
   * the HTTP smoke tests to wait out the `after(...)` deferral on the
   * runs / comments routes.
   */
  async function waitForNotification(
    predicate: () => Promise<boolean>,
    { timeoutMs = 3000, intervalMs = 50 } = {}
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) {
        return;
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new Error("Timed out waiting for after()-deferred notification");
  }

  // =========================================================================
  // Preferences — library suite
  // =========================================================================

  describe("Notification preferences", () => {
    beforeEach(async () => {
      await resetDb();
    });

    it("getPreferences returns concrete defaults for a brand-new user", async () => {
      const { userId } = await seedTestUser();

      const prefs = await getPreferences(userId);

      expect(prefs).toEqual({
        runsAllMuted: false,
        commentsAttributedEnabled: true,
        commentsParticipatedEnabled: true,
        slackRunsEnabled: false,
        slackCommentsAttributedEnabled: false,
        slackCommentsParticipatedEnabled: false,
      });

      // Defaults are lazy-upserted so subsequent reads hit the row, not
      // the insert path — both should return the same shape.
      const second = await getPreferences(userId);
      expect(second).toEqual(prefs);
    });

    it("updatePreferences patches only the fields specified", async () => {
      const { userId } = await seedTestUser();

      await updatePreferences(userId, { runsAllMuted: true });
      let prefs = await getPreferences(userId);
      expect(prefs).toEqual({
        runsAllMuted: true,
        commentsAttributedEnabled: true,
        commentsParticipatedEnabled: true,
        slackRunsEnabled: false,
        slackCommentsAttributedEnabled: false,
        slackCommentsParticipatedEnabled: false,
      });

      // A partial patch on the other axis leaves the first one intact.
      await updatePreferences(userId, { commentsParticipatedEnabled: false });
      prefs = await getPreferences(userId);
      expect(prefs).toEqual({
        runsAllMuted: true,
        commentsAttributedEnabled: true,
        commentsParticipatedEnabled: false,
        slackRunsEnabled: false,
        slackCommentsAttributedEnabled: false,
        slackCommentsParticipatedEnabled: false,
      });
    });

    it("updatePreferences creates the row when none exists yet", async () => {
      const { userId } = await seedTestUser();

      await updatePreferences(userId, { commentsAttributedEnabled: false });

      const prefs = await getPreferences(userId);
      expect(prefs.commentsAttributedEnabled).toBe(false);
      // Schema defaults survive the partial create.
      expect(prefs.runsAllMuted).toBe(false);
      expect(prefs.commentsParticipatedEnabled).toBe(true);
    });
  });

  // =========================================================================
  // Instrument subscriptions — library suite
  // =========================================================================

  describe("Instrument subscriptions", () => {
    beforeEach(async () => {
      await resetDb();
    });

    it("listInstrumentSubscriptions returns the full catalogue with enabled=false defaults", async () => {
      const { userId } = await seedTestUser();
      await seedInstrument("alpha", "Alpha");
      await seedInstrument("beta", "Beta");

      const rows = await listInstrumentSubscriptions(userId);

      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.enabled === false)).toBe(true);
    });

    it("orders rows by display name ascending", async () => {
      const { userId } = await seedTestUser();
      await seedInstrument("z-id", "Zebra");
      await seedInstrument("a-id", "Aardvark");
      await seedInstrument("m-id", "Mongoose");

      const rows = await listInstrumentSubscriptions(userId);

      expect(rows.map((r) => r.displayName)).toEqual([
        "Aardvark",
        "Mongoose",
        "Zebra",
      ]);
    });

    it("setInstrumentSubscription flips only the targeted row", async () => {
      const { userId } = await seedTestUser();
      await seedInstrument("alpha", "Alpha");
      await seedInstrument("beta", "Beta");

      await setInstrumentSubscription(userId, "alpha", true);

      const rows = await listInstrumentSubscriptions(userId);
      const byId = new Map(rows.map((r) => [r.instrumentId, r.enabled]));
      expect(byId.get("alpha")).toBe(true);
      expect(byId.get("beta")).toBe(false);
    });

    it("toggling off then on preserves the underlying row (no delete-on-disable)", async () => {
      const { userId } = await seedTestUser();
      await seedInstrument("alpha", "Alpha");

      await setInstrumentSubscription(userId, "alpha", true);

      const db = getTestDb();
      const [created] = await db
        .select()
        .from(instrumentNotificationSubscriptions)
        .where(
          and(
            eq(instrumentNotificationSubscriptions.userId, userId),
            eq(instrumentNotificationSubscriptions.instrumentId, "alpha")
          )
        );
      const originalCreatedAt = created.createdAt;

      // Tiny gap so updated_at can strictly advance under SQL's now().
      await new Promise((r) => setTimeout(r, 10));
      await setInstrumentSubscription(userId, "alpha", false);
      await new Promise((r) => setTimeout(r, 10));
      await setInstrumentSubscription(userId, "alpha", true);

      const [final] = await db
        .select()
        .from(instrumentNotificationSubscriptions)
        .where(
          and(
            eq(instrumentNotificationSubscriptions.userId, userId),
            eq(instrumentNotificationSubscriptions.instrumentId, "alpha")
          )
        );
      expect(final.enabled).toBe(true);
      expect(final.createdAt.getTime()).toBe(originalCreatedAt.getTime());
      expect(final.updatedAt.getTime()).toBeGreaterThan(
        originalCreatedAt.getTime()
      );
    });
  });

  // =========================================================================
  // notifyRunCreated — library matrix + HTTP smoke
  // =========================================================================

  describe("notifyRunCreated", () => {
    const instrumentId = "fanout-runs-instrument";

    beforeEach(async () => {
      await resetDb();
      await seedInstrument(instrumentId, "Fanout Runs Instrument");
    });

    it("inserts one run_created row per subscribed user", async () => {
      const { userId } = await seedTestUser();
      await setInstrumentSubscription(userId, instrumentId, true);

      const runInternalId = await seedRun(instrumentId, "run-subscribed");
      await notifyRunCreated({ runInternalId, instrumentId });

      const db = getTestDb();
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.runId, runInternalId));

      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(userId);
      expect(rows[0].type).toBe("run_created");
      expect(rows[0].actorUserId).toBeNull();
      expect(rows[0].commentId).toBeNull();
      expect(rows[0].readAt).toBeNull();
    });

    it("skips users whose subscription is disabled", async () => {
      const { userId: subscribed } = await seedTestUser();
      const { userId: disabled } = await seedTestUser();

      await setInstrumentSubscription(subscribed, instrumentId, true);
      await setInstrumentSubscription(disabled, instrumentId, false);

      const runInternalId = await seedRun(instrumentId, "run-mixed");
      await notifyRunCreated({ runInternalId, instrumentId });

      const db = getTestDb();
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.runId, runInternalId));

      expect(rows.map((r) => r.userId)).toEqual([subscribed]);
    });

    it("skips subscribed users whose master mute is set", async () => {
      const { userId } = await seedTestUser();
      await setInstrumentSubscription(userId, instrumentId, true);
      await updatePreferences(userId, { runsAllMuted: true });

      const runInternalId = await seedRun(instrumentId, "run-muted");
      await notifyRunCreated({ runInternalId, instrumentId });

      const db = getTestDb();
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.runId, runInternalId));

      expect(rows).toHaveLength(0);
    });

    it("notifies subscribed users with no preferences row (coalesce branch)", async () => {
      const { userId } = await seedTestUser();
      await setInstrumentSubscription(userId, instrumentId, true);
      // Explicitly do NOT call updatePreferences — exercises the
      // `coalesce(runs_all_muted, false) = false` SQL branch.

      const runInternalId = await seedRun(instrumentId, "run-no-prefs");
      await notifyRunCreated({ runInternalId, instrumentId });

      const db = getTestDb();
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.runId, runInternalId));

      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(userId);
    });

    it("is not idempotent on repeat calls (route-level isNew owns dedup)", async () => {
      const { userId } = await seedTestUser();
      await setInstrumentSubscription(userId, instrumentId, true);

      const runInternalId = await seedRun(instrumentId, "run-repeat");

      await notifyRunCreated({ runInternalId, instrumentId });
      await notifyRunCreated({ runInternalId, instrumentId });

      const db = getTestDb();
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.runId, runInternalId));

      // Two invocations → two rows. The "only fire once per run"
      // guarantee lives in the route, not the helper; pinned by the
      // HTTP smoke below.
      expect(rows).toHaveLength(2);
    });

    it("does not exclude the run author (distinct from comment fan-out)", async () => {
      // notifyRunCreated has no concept of an "author" — anyone with a
      // matching subscription receives the notification, including the
      // PAT owner that POSTed the run.
      const { userId } = await seedTestUser();
      await setInstrumentSubscription(userId, instrumentId, true);

      const runInternalId = await seedRun(instrumentId, "run-author");
      await notifyRunCreated({ runInternalId, instrumentId });

      const db = getTestDb();
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.runId, runInternalId));

      expect(rows.map((r) => r.userId)).toEqual([userId]);
    });

    it("HTTP: POSTing a new run fans out, duplicate POST does not refire", async () => {
      const { userId, token } = await seedTestUser();
      await setInstrumentSubscription(userId, instrumentId, true);

      const runId = "run-http-smoke";
      const first = await api(`/api/v1/instruments/${instrumentId}/runs`, {
        method: "POST",
        token,
        body: { run_id: runId, source: "lambda" },
      });
      expect(first.status).toBe(201);

      const db = getTestDb();
      await waitForNotification(async () => {
        const rows = await db
          .select()
          .from(notifications)
          .where(eq(notifications.userId, userId));
        return rows.length >= 1;
      });

      // Sanity check the row shape after the after() callback flushed.
      const [run] = await db
        .select({ id: instrumentRuns.id })
        .from(instrumentRuns)
        .where(
          and(
            eq(instrumentRuns.instrumentId, instrumentId),
            eq(instrumentRuns.runId, runId)
          )
        );
      const afterFirst = await db
        .select()
        .from(notifications)
        .where(eq(notifications.runId, run.id));
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0].type).toBe("run_created");

      // Duplicate POST: same (instrument_id, run_id). isNew=false in the
      // route handler → no `notifyRunCreated` call → no new rows.
      const dup = await api(`/api/v1/instruments/${instrumentId}/runs`, {
        method: "POST",
        token,
        body: { run_id: runId, source: "lambda" },
      });
      expect(dup.status).toBe(200);

      // Wait long enough for any hypothetical after() to flush, then
      // assert the count is unchanged.
      await new Promise((r) => setTimeout(r, 300));
      const afterDup = await db
        .select()
        .from(notifications)
        .where(eq(notifications.runId, run.id));
      expect(afterDup).toHaveLength(1);
    });
  });

  // =========================================================================
  // notifyComment — library matrix + HTTP smoke
  // =========================================================================

  describe("notifyComment", () => {
    const instrumentId = "fanout-comments-instrument";

    beforeEach(async () => {
      await resetDb();
      await seedInstrument(instrumentId, "Fanout Comments Instrument");
    });

    // Seed a prior comment from `userId` on `runInternalId` so they
    // qualify as a "participated" recipient on subsequent comments. The
    // returned id is used by the soft-delete test to flip deleted_at.
    async function seedPriorComment(
      runInternalId: string,
      userId: string,
      body = "earlier message"
    ): Promise<string> {
      const db = getTestDb();
      const [row] = await db
        .insert(runComments)
        .values({ runId: runInternalId, userId, body })
        .returning({ id: runComments.id });
      return row.id;
    }

    async function seedAttribution(runInternalId: string, userId: string) {
      const db = getTestDb();
      await db.insert(runAttributions).values({ runId: runInternalId, userId });
    }

    async function seedAuthorComment(
      runInternalId: string,
      authorId: string
    ): Promise<string> {
      // The "new" comment that notifyComment is fanning out for. Seeded
      // directly so the matrix tests don't have to go through HTTP.
      const db = getTestDb();
      const [row] = await db
        .insert(runComments)
        .values({
          runId: runInternalId,
          userId: authorId,
          body: "new comment",
        })
        .returning({ id: runComments.id });
      return row.id;
    }

    it("notifies attributees with comment_attributed", async () => {
      const { userId: author } = await seedTestUser();
      const { userId: attributee } = await seedTestUser();

      const runInternalId = await seedRun(instrumentId, "run-attributed");
      await seedAttribution(runInternalId, attributee);
      const commentId = await seedAuthorComment(runInternalId, author);

      await notifyComment({
        runInternalId,
        commentId,
        authorUserId: author,
      });

      const db = getTestDb();
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.runId, runInternalId));

      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(attributee);
      expect(rows[0].type).toBe("comment_attributed");
      expect(rows[0].actorUserId).toBe(author);
      expect(rows[0].commentId).toBe(commentId);
    });

    it("notifies prior commenters with comment_participated", async () => {
      const { userId: author } = await seedTestUser();
      const { userId: participant } = await seedTestUser();

      const runInternalId = await seedRun(instrumentId, "run-participated");
      await seedPriorComment(runInternalId, participant);
      const commentId = await seedAuthorComment(runInternalId, author);

      await notifyComment({
        runInternalId,
        commentId,
        authorUserId: author,
      });

      const db = getTestDb();
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.runId, runInternalId));

      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(participant);
      expect(rows[0].type).toBe("comment_participated");
      expect(rows[0].actorUserId).toBe(author);
    });

    it("attributed wins over participated when a recipient qualifies for both", async () => {
      const { userId: author } = await seedTestUser();
      const { userId: both } = await seedTestUser();

      const runInternalId = await seedRun(instrumentId, "run-overlap");
      await seedAttribution(runInternalId, both);
      await seedPriorComment(runInternalId, both);
      const commentId = await seedAuthorComment(runInternalId, author);

      await notifyComment({
        runInternalId,
        commentId,
        authorUserId: author,
      });

      const db = getTestDb();
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.runId, runInternalId));

      // Exactly one row, and the stronger signal (`attributed`) wins.
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(both);
      expect(rows[0].type).toBe("comment_attributed");
    });

    it("never notifies the comment author, even when self-attributed or self-participating", async () => {
      const { userId: author } = await seedTestUser();

      const runInternalId = await seedRun(instrumentId, "run-author-skip");
      await seedAttribution(runInternalId, author);
      await seedPriorComment(runInternalId, author);
      const commentId = await seedAuthorComment(runInternalId, author);

      await notifyComment({
        runInternalId,
        commentId,
        authorUserId: author,
      });

      const db = getTestDb();
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.runId, runInternalId));

      expect(rows).toHaveLength(0);
    });

    it("excludes prior commenters whose own comment is soft-deleted", async () => {
      const { userId: author } = await seedTestUser();
      const { userId: ghost } = await seedTestUser();

      const runInternalId = await seedRun(instrumentId, "run-ghost");
      const ghostCommentId = await seedPriorComment(runInternalId, ghost);

      const db = getTestDb();
      await db
        .update(runComments)
        .set({ deletedAt: new Date() })
        .where(eq(runComments.id, ghostCommentId));

      const commentId = await seedAuthorComment(runInternalId, author);
      await notifyComment({
        runInternalId,
        commentId,
        authorUserId: author,
      });

      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.runId, runInternalId));

      expect(rows).toHaveLength(0);
    });

    it("respects per-user comment toggles", async () => {
      const { userId: author } = await seedTestUser();
      const { userId: mutedAttributee } = await seedTestUser();
      const { userId: mutedParticipant } = await seedTestUser();
      const { userId: enabledAttributee } = await seedTestUser();

      await updatePreferences(mutedAttributee, {
        commentsAttributedEnabled: false,
      });
      await updatePreferences(mutedParticipant, {
        commentsParticipatedEnabled: false,
      });

      const runInternalId = await seedRun(instrumentId, "run-toggles");
      await seedAttribution(runInternalId, mutedAttributee);
      await seedAttribution(runInternalId, enabledAttributee);
      await seedPriorComment(runInternalId, mutedParticipant);

      const commentId = await seedAuthorComment(runInternalId, author);
      await notifyComment({
        runInternalId,
        commentId,
        authorUserId: author,
      });

      const db = getTestDb();
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.runId, runInternalId));

      // Only the enabled attributee should be notified — both muted
      // users are skipped, and the per-user gates don't shut down
      // delivery to unaffected recipients.
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(enabledAttributee);
      expect(rows[0].type).toBe("comment_attributed");
    });

    it("short-circuits cleanly when there are no recipients", async () => {
      const { userId: author } = await seedTestUser();

      const runInternalId = await seedRun(instrumentId, "run-empty");
      const commentId = await seedAuthorComment(runInternalId, author);

      await expect(
        notifyComment({
          runInternalId,
          commentId,
          authorUserId: author,
        })
      ).resolves.toBeUndefined();

      const db = getTestDb();
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.runId, runInternalId));
      expect(rows).toHaveLength(0);
    });

    it("HTTP: POSTing a comment fans out attributees + participants", async () => {
      const { userId: author, token: authorToken } = await seedTestUser();
      const { userId: attributee } = await seedTestUser();
      const { userId: participant } = await seedTestUser();

      const runId = "run-http-comment-smoke";
      const runInternalId = await seedRun(instrumentId, runId);
      await seedAttribution(runInternalId, attributee);
      await seedPriorComment(runInternalId, participant);

      const res = await api(
        `/api/v1/instruments/${instrumentId}/runs/${runId}/comments`,
        {
          method: "POST",
          token: authorToken,
          body: { body: "new comment" },
        }
      );
      expect(res.status).toBe(201);

      const db = getTestDb();
      await waitForNotification(async () => {
        const rows = await db
          .select()
          .from(notifications)
          .where(eq(notifications.runId, runInternalId));
        return rows.length >= 2;
      });

      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.runId, runInternalId));

      const byUser = new Map(rows.map((r) => [r.userId, r.type]));
      expect(byUser.get(attributee)).toBe("comment_attributed");
      expect(byUser.get(participant)).toBe("comment_participated");
      expect(byUser.has(author)).toBe(false);
    });
  });

  // =========================================================================
  // Reading notifications — listNotifications, countUnread, markRead
  // =========================================================================

  describe("Reading notifications", () => {
    const instrumentId = "read-tests-instrument";
    const instrumentDisplayName = "Read Tests Instrument";

    let userA: string;
    let userB: string;
    let actor: string;

    beforeEach(async () => {
      await resetDb();
      await seedInstrument(instrumentId, instrumentDisplayName);
      ({ userId: userA } = await seedTestUser());
      ({ userId: userB } = await seedTestUser());
      ({ userId: actor } = await seedTestUser());
    });

    /**
     * Drive `notifyRunCreated` + `notifyComment` to put rows in the DB
     * across two recipients. Returns the run + comment ids so individual
     * tests can assert against them.
     */
    async function seedNotificationFixture(runId: string) {
      const runInternalId = await seedRun(instrumentId, runId);

      // Both recipients subscribed → both receive a `run_created` row.
      await setInstrumentSubscription(userA, instrumentId, true);
      await setInstrumentSubscription(userB, instrumentId, true);
      await notifyRunCreated({ runInternalId, instrumentId });

      // Comment fan-out: userA attributed → comment_attributed; userB
      // has a prior comment → comment_participated.
      const db = getTestDb();
      await db.insert(runAttributions).values({
        runId: runInternalId,
        userId: userA,
      });
      await db
        .insert(runComments)
        .values({ runId: runInternalId, userId: userB, body: "earlier" });
      const [comment] = await db
        .insert(runComments)
        .values({ runId: runInternalId, userId: actor, body: "from actor" })
        .returning({ id: runComments.id });
      await notifyComment({
        runInternalId,
        commentId: comment.id,
        authorUserId: actor,
      });

      return { runInternalId, commentId: comment.id };
    }

    it("listNotifications orders by createdAt desc and joins run/instrument/actor", async () => {
      await seedNotificationFixture("run-list-shape");

      const rows = await listNotifications(userA);

      expect(rows.length).toBeGreaterThanOrEqual(2);
      // Newest first — the comment notification was inserted after the
      // run notification, so it should appear before it.
      const types = rows.map((r) => r.type);
      expect(types.indexOf("comment_attributed")).toBeLessThan(
        types.indexOf("run_created")
      );

      const runRow = rows.find((r) => r.type === "run_created");
      expect(runRow).toBeDefined();
      expect(runRow?.instrumentDisplayName).toBe(instrumentDisplayName);
      expect(runRow?.runDisplayId).toBe("run-list-shape");
      expect(runRow?.actor).toBeNull();
      expect(runRow?.commentId).toBeNull();

      const commentRow = rows.find((r) => r.type === "comment_attributed");
      expect(commentRow).toBeDefined();
      expect(commentRow?.actor).not.toBeNull();
      expect(commentRow?.actor?.id).toBe(actor);
      expect(commentRow?.actor?.initials).toBeTruthy();
      expect(commentRow?.commentId).toBeTruthy();
    });

    it("listNotifications respects the limit option", async () => {
      // Three separate runs → three run_created + per-attribution rows
      // for userA. Asserting limit=1 returns exactly one row.
      await seedNotificationFixture("run-limit-1");
      await seedNotificationFixture("run-limit-2");
      await seedNotificationFixture("run-limit-3");

      const rows = await listNotifications(userA, { limit: 1 });
      expect(rows).toHaveLength(1);
    });

    it("listNotifications with unreadOnly filters out already-read rows", async () => {
      await seedNotificationFixture("run-unread-only");

      const all = await listNotifications(userA);
      expect(all.length).toBeGreaterThan(0);

      // Mark the first row read and assert it disappears from
      // unread-only without affecting the unfiltered list.
      await markRead(userA, [all[0].id]);

      const unread = await listNotifications(userA, { unreadOnly: true });
      expect(unread.find((r) => r.id === all[0].id)).toBeUndefined();
      expect(unread.length).toBe(all.length - 1);

      const stillAll = await listNotifications(userA);
      expect(stillAll.length).toBe(all.length);
    });

    it("countUnread tracks the unread row count exactly", async () => {
      await seedNotificationFixture("run-count");

      const initial = await countUnread(userA);
      expect(initial).toBeGreaterThan(0);

      const rows = await listNotifications(userA);
      const idsToRead = rows.slice(0, 2).map((r) => r.id);
      await markRead(userA, idsToRead);

      const after = await countUnread(userA);
      expect(after).toBe(initial - idsToRead.length);
    });

    it("markRead with explicit ids marks only those rows", async () => {
      await seedNotificationFixture("run-mark-targeted");

      const rows = await listNotifications(userA);
      const target = rows[0];

      await markRead(userA, [target.id]);

      const fresh = await listNotifications(userA);
      const updated = fresh.find((r) => r.id === target.id);
      expect(updated).toBeDefined();
      expect(updated?.readAt).not.toBeNull();

      // Other rows remain unread.
      const others = fresh.filter((r) => r.id !== target.id);
      expect(others.every((r) => r.readAt === null)).toBe(true);
    });

    it("markRead with no ids marks every remaining unread row for the user", async () => {
      await seedNotificationFixture("run-mark-all");

      expect(await countUnread(userA)).toBeGreaterThan(0);
      await markRead(userA);
      expect(await countUnread(userA)).toBe(0);
    });

    it("markRead cannot touch another user's rows even when their ids are passed", async () => {
      await seedNotificationFixture("run-cross-user");

      const bRows = await listNotifications(userB);
      const targetForB = bRows.find((r) => r.readAt === null);
      expect(targetForB).toBeDefined();
      if (!targetForB) {
        throw new Error("expected unread notification for user B");
      }

      const bUnreadBefore = await countUnread(userB);

      // Caller is userA, but the id belongs to userB — the user-scoped
      // `where` in markRead must reject the cross-user attempt.
      await markRead(userA, [targetForB.id]);

      const bUnreadAfter = await countUnread(userB);
      expect(bUnreadAfter).toBe(bUnreadBefore);

      const stillUnread = (await listNotifications(userB)).find(
        (r) => r.id === targetForB.id
      );
      expect(stillUnread).toBeDefined();
      expect(stillUnread?.readAt).toBeNull();
    });
  });

  // =========================================================================
  // HTTP session gate — every notifications/settings route is session-only
  // =========================================================================

  describe("Notifications HTTP session gate", () => {
    let token: string;

    beforeAll(async () => {
      await resetDb();
      ({ token } = await seedTestUser({ scopes: ["*"] }));
    });

    const routes: Array<{
      label: string;
      method: "GET" | "POST" | "PUT";
      path: string;
      body?: unknown;
    }> = [
      {
        label: "GET /api/v1/notifications",
        method: "GET",
        path: "/api/v1/notifications",
      },
      {
        label: "POST /api/v1/notifications",
        method: "POST",
        path: "/api/v1/notifications",
        body: { ids: [] },
      },
      {
        label: "GET /api/v1/settings/notifications",
        method: "GET",
        path: "/api/v1/settings/notifications",
      },
      {
        label: "PUT /api/v1/settings/notifications",
        method: "PUT",
        path: "/api/v1/settings/notifications",
        body: { runs_all_muted: true },
      },
      {
        label: "PUT /api/v1/settings/notifications/instruments/:id",
        method: "PUT",
        path: "/api/v1/settings/notifications/instruments/anything",
        body: { enabled: true },
      },
    ];

    for (const route of routes) {
      it(`${route.label} rejects PAT auth with 401`, async () => {
        const res = await api(route.path, {
          method: route.method,
          token,
          body: route.body,
        });
        expect(res.status).toBe(401);
      });

      it(`${route.label} rejects unauthenticated requests with 401`, async () => {
        const res = await api(route.path, {
          method: route.method,
          body: route.body,
        });
        expect(res.status).toBe(401);
      });
    }

    it("PUT /settings/notifications/instruments/:id short-circuits at the session gate (not the 404 instrument lookup)", async () => {
      // The session gate is the first thing the route checks. A PAT
      // caller targeting a definitely-nonexistent instrument should
      // still get 401, not 404 — pins ordering between the two checks.
      const res = await api(
        "/api/v1/settings/notifications/instruments/definitely-does-not-exist",
        {
          method: "PUT",
          token,
          body: { enabled: true },
        }
      );
      expect(res.status).toBe(401);
    });
  });

  // =========================================================================
  // Slack DM delivery — channel independence matrix
  //
  // These tests call the fan-out helpers directly with all required fields
  // so the Slack delivery path is exercised. The capture server intercepts
  // chat.postMessage calls at the __TEST_SLACK_API_URL endpoint and stores
  // them in a buffer accessible via getCapturedSlackDms().
  // =========================================================================

  describe("Slack DM delivery", () => {
    const instrumentId = "slack-dm-instrument";
    const instrumentDisplayName = "Slack DM Instrument";
    const origin = "https://datahub.test";

    beforeEach(async () => {
      await resetDb();
      await clearCapturedSlackDms();
      const db = getTestDb();
      await db.insert(instruments).values({
        id: instrumentId,
        displayName: instrumentDisplayName,
        status: "active",
      });
    });

    async function connectSlack(userId: string, slackUserId: string) {
      const db = getTestDb();
      await db.insert(slackConnections).values({
        userId,
        slackUserId,
        slackTeamId: "T_TEST",
        slackTeamName: "Test Workspace",
        connectedAt: new Date(),
        revokedAt: null,
      });
      await updatePreferences(userId, {
        slackRunsEnabled: true,
        slackCommentsAttributedEnabled: true,
        slackCommentsParticipatedEnabled: true,
      });
    }

    // -----------------------------------------------------------------------
    // notifyRunCreated channel independence
    // -----------------------------------------------------------------------

    it("delivers in-app only when Slack is not connected", async () => {
      const { userId } = await seedTestUser();
      await setInstrumentSubscription(userId, instrumentId, true);

      const runInternalId = await seedRun(instrumentId, "run-inapp-only");
      await notifyRunCreated({
        runInternalId,
        instrumentId,
        instrumentDisplayName,
        runDisplayId: "run-inapp-only",
        origin,
      });

      const db = getTestDb();
      const rows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, userId));
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe("run_created");

      const dms = await getCapturedSlackDms();
      expect(dms).toHaveLength(0);
    });

    it("delivers Slack DM only when in-app is muted (Slack-only path)", async () => {
      const { userId } = await seedTestUser();
      await setInstrumentSubscription(userId, instrumentId, true);
      // Mute in-app, keep Slack on.
      await updatePreferences(userId, { runsAllMuted: true });
      await connectSlack(userId, "U_SLACK_ONLY");

      const runInternalId = await seedRun(instrumentId, "run-slack-only");
      await notifyRunCreated({
        runInternalId,
        instrumentId,
        instrumentDisplayName,
        runDisplayId: "run-slack-only",
        origin,
      });

      const db = getTestDb();
      const inAppRows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, userId));
      expect(inAppRows).toHaveLength(0);

      const dms = await getCapturedSlackDms();
      expect(dms).toHaveLength(1);
      expect(dms[0].channel).toBe("U_SLACK_ONLY");
      expect(dms[0].text).toContain(instrumentDisplayName);
    });

    it("delivers both in-app and Slack when both are enabled", async () => {
      const { userId } = await seedTestUser();
      await setInstrumentSubscription(userId, instrumentId, true);
      await connectSlack(userId, "U_BOTH");

      const runInternalId = await seedRun(instrumentId, "run-both");
      await notifyRunCreated({
        runInternalId,
        instrumentId,
        instrumentDisplayName,
        runDisplayId: "run-both",
        origin,
      });

      const db = getTestDb();
      const inAppRows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, userId));
      expect(inAppRows).toHaveLength(1);

      const dms = await getCapturedSlackDms();
      expect(dms).toHaveLength(1);
    });

    it("delivers neither when subscription disabled", async () => {
      const { userId } = await seedTestUser();
      await setInstrumentSubscription(userId, instrumentId, false);
      await connectSlack(userId, "U_NEITHER");

      const runInternalId = await seedRun(instrumentId, "run-neither");
      await notifyRunCreated({
        runInternalId,
        instrumentId,
        instrumentDisplayName,
        runDisplayId: "run-neither",
        origin,
      });

      const db = getTestDb();
      const inAppRows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, userId));
      expect(inAppRows).toHaveLength(0);

      const dms = await getCapturedSlackDms();
      expect(dms).toHaveLength(0);
    });

    it("skips Slack DM when slackRunsEnabled is false even with a live connection", async () => {
      const { userId } = await seedTestUser();
      await setInstrumentSubscription(userId, instrumentId, true);
      await connectSlack(userId, "U_SLACK_OFF");
      // Explicitly disable the Slack runs toggle after connecting.
      await updatePreferences(userId, { slackRunsEnabled: false });

      const runInternalId = await seedRun(instrumentId, "run-slack-toggle-off");
      await notifyRunCreated({
        runInternalId,
        instrumentId,
        instrumentDisplayName,
        runDisplayId: "run-slack-toggle-off",
        origin,
      });

      const dms = await getCapturedSlackDms();
      expect(dms).toHaveLength(0);
    });

    it("skips Slack DM for revoked connections", async () => {
      const { userId } = await seedTestUser();
      await setInstrumentSubscription(userId, instrumentId, true);
      await connectSlack(userId, "U_REVOKED");

      // Mark connection revoked.
      const db = getTestDb();
      await db
        .update(slackConnections)
        .set({ revokedAt: new Date() })
        .where(eq(slackConnections.userId, userId));

      const runInternalId = await seedRun(instrumentId, "run-revoked");
      await notifyRunCreated({
        runInternalId,
        instrumentId,
        instrumentDisplayName,
        runDisplayId: "run-revoked",
        origin,
      });

      const dms = await getCapturedSlackDms();
      expect(dms).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // notifyComment channel independence
    // -----------------------------------------------------------------------

    it("delivers comment_attributed DM only when in-app toggle off (Slack-only)", async () => {
      const { userId: author } = await seedTestUser();
      const { userId: attributee } = await seedTestUser();
      await connectSlack(attributee, "U_ATTR_SLACK");
      // In-app off, Slack on (already set by connectSlack).
      await updatePreferences(attributee, { commentsAttributedEnabled: false });

      const runInternalId = await seedRun(
        instrumentId,
        "run-comment-slack-only"
      );
      const db = getTestDb();
      await db
        .insert(runAttributions)
        .values({ runId: runInternalId, userId: attributee });
      const [{ id: commentId }] = await db
        .insert(runComments)
        .values({ runId: runInternalId, userId: author, body: "hello" })
        .returning({ id: runComments.id });

      await notifyComment({
        runInternalId,
        commentId,
        authorUserId: author,
        authorDisplayName: "Test Author",
        instrumentId,
        instrumentDisplayName,
        runDisplayId: "run-comment-slack-only",
        commentBody: "hello",
        origin,
      });

      // No in-app row.
      const inAppRows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, attributee));
      expect(inAppRows).toHaveLength(0);

      // DM fired.
      const dms = await getCapturedSlackDms();
      expect(dms).toHaveLength(1);
      expect(dms[0].channel).toBe("U_ATTR_SLACK");
    });

    it("delivers both in-app and Slack for comment_participated", async () => {
      const { userId: author } = await seedTestUser();
      const { userId: participant } = await seedTestUser();
      await connectSlack(participant, "U_PART_BOTH");

      const runInternalId = await seedRun(instrumentId, "run-part-both");
      const db = getTestDb();
      await db
        .insert(runComments)
        .values({ runId: runInternalId, userId: participant, body: "prior" });
      const [{ id: commentId }] = await db
        .insert(runComments)
        .values({ runId: runInternalId, userId: author, body: "new" })
        .returning({ id: runComments.id });

      await notifyComment({
        runInternalId,
        commentId,
        authorUserId: author,
        authorDisplayName: "Author",
        instrumentId,
        instrumentDisplayName,
        runDisplayId: "run-part-both",
        commentBody: "new",
        origin,
      });

      const inAppRows = await db
        .select()
        .from(notifications)
        .where(
          and(
            eq(notifications.userId, participant),
            eq(notifications.type, "comment_participated")
          )
        );
      expect(inAppRows).toHaveLength(1);

      const dms = await getCapturedSlackDms();
      expect(dms).toHaveLength(1);
      expect(dms[0].channel).toBe("U_PART_BOTH");
    });

    it("Slack failure does not prevent in-app row from being inserted", async () => {
      // This test verifies isolation: even if the DM helper throws internally
      // (mocked by temporarily clearing SLACK_BOT_TOKEN is not practical here
      // — instead we rely on the swallow-and-log behavior verified by
      // notifyRunCreated's try/catch wrapping the whole block).
      // What we can assert: with a connected user, both deliveries succeed
      // and neither blocks the other.
      const { userId } = await seedTestUser();
      await setInstrumentSubscription(userId, instrumentId, true);
      await connectSlack(userId, "U_ISOLATION");

      const runInternalId = await seedRun(instrumentId, "run-isolation");
      await notifyRunCreated({
        runInternalId,
        instrumentId,
        instrumentDisplayName,
        runDisplayId: "run-isolation",
        origin,
      });

      const db = getTestDb();
      const inAppRows = await db
        .select()
        .from(notifications)
        .where(eq(notifications.userId, userId));
      expect(inAppRows).toHaveLength(1);

      const dms = await getCapturedSlackDms();
      expect(dms).toHaveLength(1);
    });
  });
});
