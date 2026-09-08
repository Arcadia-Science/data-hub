import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listNotifications, updatePreferences } from "@/lib/api/notifications";
import {
  instrumentRuns,
  instruments,
  notifications,
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

// End-to-end coverage for `POST /api/v1/notifications/dispatch`, the
// machine-facing surface for integration-posted `generic` notifications.
// The route is PAT-only, so every call goes through the seeded-token
// harness. In-app inserts are synchronous and asserted via the response +
// DB; Slack DMs fire in `after()`, so DM assertions poll the capture
// buffer like the notifications suite polls for rows.

interface DispatchResponse {
  notified_user_ids: string[];
  skipped_user_ids: string[];
}

describe("Notification dispatch", () => {
  const instrumentId = "dispatch-instrument";
  const runId = "dispatch-run";
  const message = "This run might be yours to claim.";

  beforeAll(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDb();
    await clearCapturedSlackDms();
    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: "Dispatch Instrument",
      status: "active",
    });
  });

  async function seedRun(displayId = runId): Promise<string> {
    const db = getTestDb();
    const [row] = await db
      .insert(instrumentRuns)
      .values({ instrumentId, runId: displayId, source: "lambda" })
      .returning({ id: instrumentRuns.id });
    return row.id;
  }

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
  }

  /** Polls until the after()-deferred Slack DMs land in the capture buffer. */
  async function waitForDms(count: number): Promise<void> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if ((await getCapturedSlackDms()).length >= count) {
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`Timed out waiting for ${count} Slack DM(s)`);
  }

  async function dispatch(token: string, body: Record<string, unknown>) {
    const res = await api("/api/v1/notifications/dispatch", {
      method: "POST",
      token,
      body,
    });
    return { res, body: (await res.json()) as DispatchResponse };
  }

  function rowsFor(userId: string) {
    const db = getTestDb();
    return db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, userId));
  }

  // =========================================================================
  // Auth + validation gates
  // =========================================================================

  describe("auth and validation", () => {
    it("rejects requests without a token", async () => {
      const res = await api("/api/v1/notifications/dispatch", {
        method: "POST",
        body: { user_ids: ["u1"], message },
      });
      expect(res.status).toBe(401);
    });

    it("rejects a token without the notifications:create scope", async () => {
      const { token } = await seedTestUser({ scopes: ["runs:read"] });
      const res = await api("/api/v1/notifications/dispatch", {
        method: "POST",
        token,
        body: { user_ids: ["u1"], message },
      });
      expect(res.status).toBe(403);
    });

    it("rejects malformed bodies", async () => {
      const { token } = await seedTestUser({
        scopes: ["notifications:create"],
      });

      const cases: Record<string, unknown>[] = [
        // Empty recipient list.
        { user_ids: [], message },
        // Over the 50-recipient cap.
        { user_ids: Array.from({ length: 51 }, (_, i) => `u${i}`), message },
        // Missing message.
        { user_ids: ["u1"] },
        // Whitespace-only message (trimmed before min(1)).
        { user_ids: ["u1"], message: "   " },
        // Over the 500-char cap.
        { user_ids: ["u1"], message: "x".repeat(501) },
      ];
      for (const body of cases) {
        const res = await api("/api/v1/notifications/dispatch", {
          method: "POST",
          token,
          body,
        });
        expect(res.status).toBe(400);
      }
    });
  });

  // =========================================================================
  // Dispatch behavior
  // =========================================================================

  describe("dispatch", () => {
    it("delivers a run-anchored notification in-app by default", async () => {
      const { userId: actorId, token } = await seedTestUser({
        name: "Claim Bot",
        scopes: ["notifications:create"],
      });
      const { userId: recipient } = await seedTestUser();
      const internalId = await seedRun();

      const { res, body } = await dispatch(token, {
        user_ids: [recipient],
        message,
        run: { instrument_id: instrumentId, run_id: runId },
      });

      expect(res.status).toBe(201);
      expect(body.notified_user_ids).toEqual([recipient]);
      expect(body.skipped_user_ids).toEqual([]);

      const rows = await rowsFor(recipient);
      expect(rows).toHaveLength(1);
      expect(rows[0].type).toBe("generic");
      expect(rows[0].body).toBe(message);
      expect(rows[0].runId).toBe(internalId);
      expect(rows[0].actorUserId).toBe(actorId);
      expect(rows[0].readAt).toBeNull();
    });

    it("delivers an anchor-less notification and lists it", async () => {
      const { token } = await seedTestUser({
        scopes: ["notifications:create"],
      });
      const { userId: recipient } = await seedTestUser();

      const { res, body } = await dispatch(token, {
        user_ids: [recipient],
        message: "Scheduled maintenance tonight.",
      });

      expect(res.status).toBe(201);
      expect(body.notified_user_ids).toEqual([recipient]);

      const rows = await rowsFor(recipient);
      expect(rows).toHaveLength(1);
      expect(rows[0].runId).toBeNull();

      // The bell's read path must surface run-less rows (left joins).
      const list = await listNotifications(recipient);
      expect(list).toHaveLength(1);
      expect(list[0].type).toBe("generic");
      expect(list[0].body).toBe("Scheduled maintenance tonight.");
      expect(list[0].runId).toBeNull();
      expect(list[0].instrumentId).toBeNull();
    });

    it("reports unknown user IDs as skipped and still notifies the rest", async () => {
      const { token } = await seedTestUser({
        scopes: ["notifications:create"],
      });
      const { userId: recipient } = await seedTestUser();

      const { body } = await dispatch(token, {
        user_ids: [recipient, "no-such-user"],
        message,
      });

      expect(body.notified_user_ids).toEqual([recipient]);
      expect(body.skipped_user_ids).toEqual(["no-such-user"]);
    });

    it("never notifies the actor, even when listed", async () => {
      const { userId: actorId, token } = await seedTestUser({
        scopes: ["notifications:create"],
      });
      const { userId: recipient } = await seedTestUser();

      const { body } = await dispatch(token, {
        user_ids: [actorId, recipient],
        message,
      });

      expect(body.notified_user_ids).toEqual([recipient]);
      expect(body.skipped_user_ids).toEqual([actorId]);
      expect(await rowsFor(actorId)).toHaveLength(0);
    });

    it("rejects an unknown run reference with 400", async () => {
      const { token } = await seedTestUser({
        scopes: ["notifications:create"],
      });
      const { userId: recipient } = await seedTestUser();

      const { res } = await dispatch(token, {
        user_ids: [recipient],
        message,
        run: { instrument_id: instrumentId, run_id: "no-such-run" },
      });
      expect(res.status).toBe(400);
    });

    it("rejects a soft-deleted run with 409", async () => {
      const { token } = await seedTestUser({
        scopes: ["notifications:create"],
      });
      const { userId: recipient } = await seedTestUser();
      const internalId = await seedRun();

      const db = getTestDb();
      await db
        .update(instrumentRuns)
        .set({ deletedAt: new Date() })
        .where(eq(instrumentRuns.id, internalId));

      const { res } = await dispatch(token, {
        user_ids: [recipient],
        message,
        run: { instrument_id: instrumentId, run_id: runId },
      });
      expect(res.status).toBe(409);
    });

    it("skips exact repeats while unread, redelivers when read or changed", async () => {
      const { token } = await seedTestUser({
        scopes: ["notifications:create"],
      });
      const { userId: recipient } = await seedTestUser();
      await seedRun();
      const run = { instrument_id: instrumentId, run_id: runId };

      const first = await dispatch(token, {
        user_ids: [recipient],
        message,
        run,
      });
      expect(first.body.notified_user_ids).toEqual([recipient]);

      // Same message + same anchor, still unread → skipped.
      const repeat = await dispatch(token, {
        user_ids: [recipient],
        message,
        run,
      });
      expect(repeat.body.notified_user_ids).toEqual([]);
      expect(repeat.body.skipped_user_ids).toEqual([recipient]);
      expect(await rowsFor(recipient)).toHaveLength(1);

      // A different message to the same user delivers again.
      const changed = await dispatch(token, {
        user_ids: [recipient],
        message: "Different message.",
        run,
      });
      expect(changed.body.notified_user_ids).toEqual([recipient]);
      expect(await rowsFor(recipient)).toHaveLength(2);

      // Once every copy is read, the original message delivers again.
      const db = getTestDb();
      await db
        .update(notifications)
        .set({ readAt: new Date() })
        .where(eq(notifications.userId, recipient));
      const afterRead = await dispatch(token, {
        user_ids: [recipient],
        message,
        run,
      });
      expect(afterRead.body.notified_user_ids).toEqual([recipient]);
      expect(await rowsFor(recipient)).toHaveLength(3);
    });

    it("dedupes anchor-less repeats independently of anchored ones", async () => {
      const { token } = await seedTestUser({
        scopes: ["notifications:create"],
      });
      const { userId: recipient } = await seedTestUser();

      // Anchor-less and run-anchored rows with the same message are
      // distinct deliveries — the anchor is part of the repeat key.
      await seedRun();
      await dispatch(token, { user_ids: [recipient], message });
      const anchored = await dispatch(token, {
        user_ids: [recipient],
        message,
        run: { instrument_id: instrumentId, run_id: runId },
      });
      expect(anchored.body.notified_user_ids).toEqual([recipient]);

      const anchorlessRepeat = await dispatch(token, {
        user_ids: [recipient],
        message,
      });
      expect(anchorlessRepeat.body.skipped_user_ids).toEqual([recipient]);
      expect(await rowsFor(recipient)).toHaveLength(2);
    });
  });

  // =========================================================================
  // Per-channel preference gating
  // =========================================================================

  describe("channel gating", () => {
    it("skips in-app delivery when genericEnabled is false", async () => {
      const { token } = await seedTestUser({
        scopes: ["notifications:create"],
      });
      const { userId: recipient } = await seedTestUser();
      await updatePreferences(recipient, { genericEnabled: false });

      const { body } = await dispatch(token, {
        user_ids: [recipient],
        message,
      });

      expect(body.notified_user_ids).toEqual([]);
      expect(body.skipped_user_ids).toEqual([recipient]);
      expect(await rowsFor(recipient)).toHaveLength(0);
    });

    it("sends a Slack DM when connected and slackGenericEnabled", async () => {
      const { token } = await seedTestUser({
        name: "Claim Bot",
        scopes: ["notifications:create"],
      });
      const { userId: recipient } = await seedTestUser();
      await connectSlack(recipient, "U_GENERIC");
      await updatePreferences(recipient, { slackGenericEnabled: true });
      await seedRun();

      const { body } = await dispatch(token, {
        user_ids: [recipient],
        message,
        run: { instrument_id: instrumentId, run_id: runId },
      });

      // Both channels on → in-app row plus the DM.
      expect(body.notified_user_ids).toEqual([recipient]);
      expect(await rowsFor(recipient)).toHaveLength(1);

      await waitForDms(1);
      const dms = await getCapturedSlackDms();
      expect(dms[0].channel).toBe("U_GENERIC");
      expect(dms[0].text).toContain("Claim Bot");
      expect(dms[0].text).toContain(message);
    });

    it("counts a Slack-only recipient as notified", async () => {
      const { token } = await seedTestUser({
        scopes: ["notifications:create"],
      });
      const { userId: recipient } = await seedTestUser();
      await connectSlack(recipient, "U_SLACK_ONLY_GENERIC");
      // In-app off, Slack on.
      await updatePreferences(recipient, {
        genericEnabled: false,
        slackGenericEnabled: true,
      });

      const { body } = await dispatch(token, {
        user_ids: [recipient],
        message,
      });

      expect(body.notified_user_ids).toEqual([recipient]);
      expect(await rowsFor(recipient)).toHaveLength(0);

      await waitForDms(1);
      const dms = await getCapturedSlackDms();
      expect(dms[0].channel).toBe("U_SLACK_ONLY_GENERIC");
    });

    it("sends no DM when the Slack toggle is off or the connection revoked", async () => {
      const { token } = await seedTestUser({
        scopes: ["notifications:create"],
      });
      const { userId: toggleOff } = await seedTestUser();
      const { userId: revoked } = await seedTestUser();
      // Connected but the toggle stays at its default (off).
      await connectSlack(toggleOff, "U_TOGGLE_OFF");
      // Connected, enabled, then revoked.
      await connectSlack(revoked, "U_REVOKED_GENERIC");
      await updatePreferences(revoked, { slackGenericEnabled: true });
      const db = getTestDb();
      await db
        .update(slackConnections)
        .set({ revokedAt: new Date() })
        .where(eq(slackConnections.userId, revoked));

      const { body } = await dispatch(token, {
        user_ids: [toggleOff, revoked],
        message,
      });

      // In-app is on by default, so both are still notified — just no DMs.
      expect(body.notified_user_ids.sort()).toEqual(
        [toggleOff, revoked].sort()
      );

      // Give the after() hook a beat to (not) fire, then assert the buffer
      // stayed empty.
      await new Promise((r) => setTimeout(r, 500));
      expect(await getCapturedSlackDms()).toHaveLength(0);
    });
  });
});
