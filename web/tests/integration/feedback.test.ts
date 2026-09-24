import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listFeedback } from "@/lib/api/feedback";
import {
  listNotifications,
  notifyFeedbackSubmitted,
  notifyFeedbackUpdated,
  updatePreferences,
} from "@/lib/api/notifications";
import { feedback, slackConnections } from "@/lib/db/schema";
import {
  api,
  clearCapturedSlackDms,
  closeTestDb,
  getCapturedSlackDms,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for feedback notification");
}

describe("Feedback", () => {
  beforeAll(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await resetDb();
    await clearCapturedSlackDms();
  });

  it("returns the existing open report when the same title is sent again", async () => {
    const { token } = await seedTestUser();
    const first = await api("/api/v1/feedback", {
      method: "POST",
      token,
      body: {
        kind: "bug",
        title: "Export fails",
        description: "The download stops.",
      },
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const second = await api("/api/v1/feedback", {
      method: "POST",
      token,
      body: {
        kind: "bug",
        title: "Export fails",
        description: "Tried again.",
      },
    });
    expect(second.status).toBe(201);
    const secondBody = await second.json();
    expect(secondBody.duplicate).toBe(true);
    expect(secondBody.feedback.id).toBe(firstBody.feedback.id);
  });

  it("shows admins every report and members only their own", async () => {
    const admin = await seedTestUser({
      isAdmin: true,
      email: "admin@example.com",
    });
    const member = await seedTestUser({ email: "member@example.com" });
    const db = getTestDb();
    await db.insert(feedback).values([
      {
        userId: member.userId,
        source: "web",
        kind: "feature_request",
        title: "Darker charts",
        description: "The plot is hard to read.",
      },
      {
        userId: admin.userId,
        source: "web",
        kind: "other",
        title: "Thanks",
        description: "The new table is easier to scan.",
      },
    ]);

    const asMember = await listFeedback({
      viewerId: member.userId,
      isAdmin: false,
      limit: 25,
      offset: 0,
    });
    expect(asMember.items.map((item) => item.title)).toEqual(["Darker charts"]);

    const asAdmin = await listFeedback({
      viewerId: admin.userId,
      isAdmin: true,
      limit: 25,
      offset: 0,
    });
    expect(asAdmin.total).toBe(2);
  });

  it("notifies other admins in-app and by Slack, and skips a muted admin", async () => {
    const reporter = await seedTestUser({ email: "reporter@example.com" });
    const admin = await seedTestUser({
      isAdmin: true,
      email: "admin@example.com",
    });
    const muted = await seedTestUser({
      isAdmin: true,
      email: "muted@example.com",
    });
    const [created] = await getTestDb()
      .insert(feedback)
      .values({
        userId: reporter.userId,
        source: "mcp",
        kind: "bug",
        title: "Export fails",
        description: "Stops halfway.",
      })
      .returning({ id: feedback.id, title: feedback.title });
    await getTestDb().insert(slackConnections).values({
      userId: admin.userId,
      slackUserId: "U_ADMIN",
      slackTeamId: "T_TEST",
      slackTeamName: "Test",
    });
    await updatePreferences(admin.userId, {
      slackFeedbackSubmittedEnabled: true,
    });
    await updatePreferences(muted.userId, { feedbackSubmittedEnabled: false });

    await notifyFeedbackSubmitted({
      feedbackId: created.id,
      reporterUserId: reporter.userId,
      reporterDisplayName: "Reporter",
      title: created.title,
      origin: "https://datahub.test",
    });

    const adminNotes = await listNotifications(admin.userId);
    expect(adminNotes).toEqual([
      expect.objectContaining({
        type: "feedback_submitted",
        body: "Export fails",
      }),
    ]);
    expect(await listNotifications(muted.userId)).toHaveLength(0);
    const dms = await getCapturedSlackDms();
    expect(dms.map((dm) => dm.channel)).toContain("U_ADMIN");
  });

  it("notifies the reporter on resolve, and skips them when the switch is off", async () => {
    const reporter = await seedTestUser({ email: "reporter@example.com" });
    const admin = await seedTestUser({
      isAdmin: true,
      email: "admin@example.com",
    });
    const [created] = await getTestDb()
      .insert(feedback)
      .values({
        userId: reporter.userId,
        source: "web",
        kind: "bug",
        title: "Export fails",
        description: "Stops halfway.",
      })
      .returning({ id: feedback.id, title: feedback.title });

    await notifyFeedbackUpdated({
      feedbackId: created.id,
      reporterUserId: reporter.userId,
      adminUserId: admin.userId,
      title: created.title,
      status: "resolved",
      note: "Fixed in the latest build.",
    });

    const [note] = await listNotifications(reporter.userId);
    expect(note.body).toContain("Resolved");
    expect(note.body).toContain("Fixed in the latest build.");

    await updatePreferences(reporter.userId, { feedbackUpdatedEnabled: false });
    await notifyFeedbackUpdated({
      feedbackId: created.id,
      reporterUserId: reporter.userId,
      adminUserId: admin.userId,
      title: created.title,
      status: "declined",
      note: "Won't do.",
    });
    const notes = await listNotifications(reporter.userId);
    expect(notes.filter((row) => row.body?.includes("Declined"))).toHaveLength(
      0
    );
  });

  it("accepts a read-only token on POST and rejects a non-admin PATCH", async () => {
    const admin = await seedTestUser({
      isAdmin: true,
      email: "admin@example.com",
    });
    const member = await seedTestUser({
      scopes: ["instruments:read"],
      email: "member@example.com",
    });
    const created = await api("/api/v1/feedback", {
      method: "POST",
      token: member.token,
      body: {
        kind: "bug",
        title: "Search misses files",
        description: "A filename search returns nothing.",
      },
    });
    expect(created.status).toBe(201);
    const payload = await created.json();

    await waitFor(async () => {
      const rows = await listNotifications(admin.userId);
      return rows.some((row) => row.type === "feedback_submitted");
    });

    const patched = await api(`/api/v1/feedback/${payload.feedback.id}`, {
      method: "PATCH",
      token: member.token,
      body: { status: "resolved", note: "nope" },
    });
    expect(patched.status).toBe(403);

    const ok = await api(`/api/v1/feedback/${payload.feedback.id}`, {
      method: "PATCH",
      token: admin.token,
      body: { status: "resolved", note: "Shipped." },
    });
    expect(ok.status).toBe(200);

    const listed = await api("/api/v1/feedback?status=resolved", {
      token: member.token,
    });
    expect(listed.status).toBe(200);
    const listBody = await listed.json();
    expect(listBody.feedback).toHaveLength(1);
    expect(listBody.feedback[0].title).toBe("Search misses files");
  });
});
