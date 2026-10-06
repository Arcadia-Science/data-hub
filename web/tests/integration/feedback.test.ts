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
  getBaseUrl,
  getCapturedSlackDms,
  getMcpAccessToken,
  getTestDb,
  resetDb,
  seedSessionCookie,
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
    const { userId } = await seedTestUser();
    const headers = { Cookie: await seedSessionCookie(userId) };
    const first = await api("/api/v1/feedback", {
      method: "POST",
      headers,
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
      headers,
      body: {
        kind: "bug",
        title: "Export fails",
        description: "Tried again.",
      },
    });
    expect(second.status).toBe(200);
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

  it("lets a member submit and see their own reports", async () => {
    const admin = await seedTestUser({
      isAdmin: true,
      email: "admin@example.com",
    });
    const member = await seedTestUser({ email: "member@example.com" });
    const memberHeaders = { Cookie: await seedSessionCookie(member.userId) };
    const adminHeaders = { Cookie: await seedSessionCookie(admin.userId) };
    const created = await api("/api/v1/feedback", {
      method: "POST",
      headers: memberHeaders,
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
      headers: adminHeaders,
      body: { status: "resolved", note: "Shipped." },
    });
    expect(patched.status).toBe(404);

    const listed = await api("/api/v1/feedback", {
      headers: memberHeaders,
    });
    expect(listed.status).toBe(200);
    const listBody = await listed.json();
    expect(listBody.feedback).toHaveLength(1);
    expect(listBody.feedback[0].title).toBe("Search misses files");
  });

  it("shows an admin every member's reports", async () => {
    const admin = await seedTestUser({
      isAdmin: true,
      email: "list-admin@example.com",
    });
    const other = await seedTestUser({ email: "other-reporter@example.com" });
    await getTestDb().insert(feedback).values({
      userId: other.userId,
      source: "web",
      kind: "bug",
      title: "Someone else's report",
      description: "Visible to admins.",
    });

    const listed = await api("/api/v1/feedback", {
      headers: { Cookie: await seedSessionCookie(admin.userId) },
    });
    expect(listed.status).toBe(200);
    expect((await listed.json()).total).toBe(1);
  });

  it("rejects personal access tokens on every feedback route", async () => {
    // Feedback belongs to the person who wrote it, so even an admin's
    // wildcard token is turned away.
    const admin = await seedTestUser({
      isAdmin: true,
      email: "token-admin@example.com",
    });
    const reporter = await seedTestUser({ email: "reporter-2@example.com" });
    const [report] = await getTestDb()
      .insert(feedback)
      .values({
        userId: reporter.userId,
        source: "web",
        kind: "bug",
        title: "A report",
        description: "Seeded directly.",
      })
      .returning({ id: feedback.id });

    const created = await api("/api/v1/feedback", {
      method: "POST",
      token: admin.token,
      body: {
        kind: "bug",
        title: "Sent with a token",
        description: "This should not be saved.",
      },
    });
    expect(created.status).toBe(401);

    const listed = await api("/api/v1/feedback", { token: admin.token });
    expect(listed.status).toBe(401);

    const patched = await api(`/api/v1/feedback/${report.id}`, {
      method: "PATCH",
      token: admin.token,
      body: { status: "resolved" },
    });
    expect(patched.status).toBe(404);

    const rows = await getTestDb().select({ id: feedback.id }).from(feedback);
    expect(rows).toHaveLength(1);
  });

  it("keeps the review page up when the item id is not a uuid", async () => {
    const admin = await seedTestUser({
      isAdmin: true,
      email: "page-admin@example.com",
    });
    const cookie = await seedSessionCookie(admin.userId);
    const res = await fetch(
      `${getBaseUrl()}/settings/feedback?item=not-a-uuid`,
      { headers: { cookie }, redirect: "manual" }
    );
    expect(res.status).toBeLessThan(500);
  });

  it("sends feedback over MCP with a read-only access token", async () => {
    const { userId } = await seedTestUser({
      email: "mcp-reader@example.com",
    });
    const token = await getMcpAccessToken(userId, "read");
    const res = await api("/mcp/v1", {
      method: "POST",
      token,
      headers: { Accept: "application/json, text/event-stream" },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "send_feedback",
          arguments: {
            kind: "bug",
            title: "MCP read token",
            description: "A long enough description.",
          },
        },
      },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    expect(dataLine).toBeTruthy();
    const payload = JSON.parse(dataLine?.slice("data: ".length) ?? "{}");
    expect(payload.result?.isError).not.toBe(true);
    expect(payload.result?.content?.[0]?.text).toContain("MCP read token");
  });
});
