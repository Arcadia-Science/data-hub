import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FEEDBACK_NOT_CONFIGURED_MESSAGE } from "@/lib/api/feedback";
import {
  listNotifications,
  notifyFeedbackSubmitted,
  updatePreferences,
} from "@/lib/api/notifications";
import { slackConnections } from "@/lib/db/schema";
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
import { LINEAR_TEAM_ID } from "@/tests/integration/linear-fake-server";

function linearBase(): string {
  const base = process.env.__TEST_LINEAR_API_URL;
  if (!base) {
    throw new Error("__TEST_LINEAR_API_URL is not set");
  }
  return base;
}

async function resetLinear() {
  const res = await fetch(`${linearBase()}/__test/reset`, { method: "POST" });
  if (!res.ok) {
    throw new Error("Failed to reset the Linear fake server");
  }
}

async function linearIssues(): Promise<
  {
    attachments: { metadata: Record<string, string>; url: string }[];
    title: string;
  }[]
> {
  const res = await fetch(`${linearBase()}/__test/issues`);
  return res.json();
}

async function enableLinear(cookie: string) {
  const res = await api("/api/v1/settings/integrations/linear", {
    method: "PUT",
    headers: { Cookie: cookie },
    body: {
      client_id: "client-1",
      client_secret: "secret",
      team: { id: LINEAR_TEAM_ID, name: "Data Hub" },
    },
  });
  expect(res.status).toBe(200);
}

describe("Feedback", () => {
  beforeAll(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    // Creating a report notifies admins after the response. Truncating
    // while that insert is still running deadlocks Postgres.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await resetDb();
        break;
      } catch (err) {
        if (attempt === 2) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    await resetLinear();
    await clearCapturedSlackDms();
  });

  it("returns the existing open report when the same title is sent again", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    await enableLinear(await seedSessionCookie(admin.userId));
    const headers = { Cookie: await seedSessionCookie(admin.userId) };
    const body = {
      kind: "bug",
      title: "Export button does nothing",
      description: "Clicking export leaves the page unchanged.",
    };
    const first = await api("/api/v1/feedback", {
      method: "POST",
      headers,
      body,
    });
    expect(first.status).toBe(201);
    const second = await api("/api/v1/feedback", {
      method: "POST",
      headers,
      body,
    });
    expect(second.status).toBe(200);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(secondBody.duplicate).toBe(true);
    expect(secondBody.feedback.id).toBe(firstBody.feedback.id);
    expect(await linearIssues()).toHaveLength(1);
  });

  it("stores the report as a Linear issue with a Data Hub attachment", async () => {
    const admin = await seedTestUser({
      isAdmin: true,
      name: "Ada Admin",
      email: "ada@example.com",
    });
    await enableLinear(await seedSessionCookie(admin.userId));
    const created = await api("/api/v1/feedback", {
      method: "POST",
      headers: { Cookie: await seedSessionCookie(admin.userId) },
      body: {
        kind: "bug",
        title: "Export fails",
        description: "Stops halfway.",
        attempted_action: "Download the run",
        error_message: "Network error",
      },
    });
    expect(created.status).toBe(201);
    const payload = await created.json();
    expect(payload.feedback.linear_issue.identifier).toMatch(/^DH-/);
    expect(payload.feedback.admin_note).toBeNull();
    expect(payload.feedback.status_updated_by).toBeNull();
    expect(payload.feedback.reporter.email).toBe("ada@example.com");

    const [issue] = await linearIssues();
    expect(issue.title).toBe("Export fails");
    expect(issue.attachments).toHaveLength(1);
    expect(issue.attachments[0].url).toContain(
      `/feedback/r/${encodeURIComponent(admin.userId)}/k/bug/`
    );
    expect(issue.attachments[0].metadata).toMatchObject({
      reporterUserId: admin.userId,
      kind: "bug",
      description: "Stops halfway.",
      source: "web",
    });
  });

  it("returns 503 and creates nothing when Linear rejects the issue", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    await enableLinear(await seedSessionCookie(admin.userId));
    const res = await api("/api/v1/feedback", {
      method: "POST",
      headers: { Cookie: await seedSessionCookie(admin.userId) },
      body: {
        kind: "bug",
        title: "__fail_linear__",
        description: "This should not be stored.",
      },
    });
    expect(res.status).toBe(503);
    expect(await linearIssues()).toHaveLength(0);
  });

  it("says feedback is not set up when Linear has no team", async () => {
    const { userId } = await seedTestUser();
    const res = await api("/api/v1/feedback", {
      method: "POST",
      headers: { Cookie: await seedSessionCookie(userId) },
      body: {
        kind: "bug",
        title: "Anything",
        description: "A long enough description.",
      },
    });
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toBe(
      FEEDBACK_NOT_CONFIGURED_MESSAGE
    );
  });

  it("shows an admin every report and a member only their own", async () => {
    const admin = await seedTestUser({
      isAdmin: true,
      email: "admin@example.com",
    });
    const member = await seedTestUser({ email: "member@example.com" });
    const other = await seedTestUser({ email: "other@example.com" });
    await enableLinear(await seedSessionCookie(admin.userId));
    const memberHeaders = { Cookie: await seedSessionCookie(member.userId) };
    const otherHeaders = { Cookie: await seedSessionCookie(other.userId) };

    expect(
      (
        await api("/api/v1/feedback", {
          method: "POST",
          headers: memberHeaders,
          body: {
            kind: "bug",
            title: "Member report",
            description: "From the member.",
          },
        })
      ).status
    ).toBe(201);
    expect(
      (
        await api("/api/v1/feedback", {
          method: "POST",
          headers: otherHeaders,
          body: {
            kind: "feature_request",
            title: "Other report",
            description: "From someone else.",
          },
        })
      ).status
    ).toBe(201);

    const memberList = await api("/api/v1/feedback", {
      headers: memberHeaders,
    });
    expect(memberList.status).toBe(200);
    const memberBody = await memberList.json();
    expect(memberBody.total).toBe(1);
    expect(memberBody.feedback[0].title).toBe("Member report");
    expect(memberBody.counts).toEqual({ open: 1, resolved: 0, declined: 0 });

    const adminList = await api("/api/v1/feedback", {
      headers: { Cookie: await seedSessionCookie(admin.userId) },
    });
    const adminBody = await adminList.json();
    expect(adminBody.total).toBe(2);
    expect(adminBody.counts.open).toBe(2);
  });

  it("does not return a Linear issue that is not a Data Hub report", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const cookie = await seedSessionCookie(admin.userId);
    await enableLinear(cookie);
    const seeded = await fetch(`${linearBase()}/__test/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Internal engineering issue" }),
    });
    const { id } = (await seeded.json()) as { id: string };
    const token = await getMcpAccessToken(admin.userId, "read");
    const res = await api("/mcp/v1", {
      method: "POST",
      token,
      headers: { Accept: "application/json, text/event-stream" },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_feedback", arguments: { id } },
      },
    });
    const text = await res.text();
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    const payload = JSON.parse(dataLine?.slice("data: ".length) ?? "{}");
    expect(payload.result?.isError).toBe(true);
  });

  it("notifies admins when feedback is submitted", async () => {
    const reporter = await seedTestUser({ email: "reporter@example.com" });
    const admin = await seedTestUser({
      isAdmin: true,
      email: "notify-admin@example.com",
    });
    const muted = await seedTestUser({
      isAdmin: true,
      email: "muted-admin@example.com",
    });
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
      feedbackId: randomUUID(),
      reporterUserId: reporter.userId,
      reporterDisplayName: "Reporter",
      title: "Export fails",
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

  it("rejects personal access tokens", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const res = await api("/api/v1/feedback", {
      method: "POST",
      token: admin.token,
      body: {
        kind: "bug",
        title: "Sent with a token",
        description: "This should not be saved.",
      },
    });
    expect(res.status).toBe(401);
    expect(await linearIssues()).toHaveLength(0);
  });

  it("keeps the review page up when the item id is not a uuid", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const res = await fetch(
      `${getBaseUrl()}/settings/feedback?item=not-a-uuid`,
      {
        headers: { cookie: await seedSessionCookie(admin.userId) },
        redirect: "manual",
      }
    );
    expect(res.status).toBeLessThan(500);
  });

  it("redirects a Linear attachment link to the report", async () => {
    const res = await fetch(
      `${getBaseUrl()}/feedback/r/user-1/k/bug/11111111-1111-4111-8111-111111111111`,
      { redirect: "manual" }
    );
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toContain(
      "/settings/feedback?item=11111111-1111-4111-8111-111111111111"
    );
  });

  it("sends feedback over MCP with a read-only access token", async () => {
    const admin = await seedTestUser({
      isAdmin: true,
      email: "mcp-admin@example.com",
    });
    await enableLinear(await seedSessionCookie(admin.userId));
    const { userId } = await seedTestUser({ email: "mcp-reader@example.com" });
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
    const payload = JSON.parse(dataLine?.slice("data: ".length) ?? "{}");
    expect(payload.result?.isError).not.toBe(true);
  });

  it("tells an MCP client when feedback is not set up", async () => {
    const { userId } = await seedTestUser({ email: "mcp-unset@example.com" });
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
            title: "Not configured",
            description: "A long enough description.",
          },
        },
      },
    });
    const text = await res.text();
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    const payload = JSON.parse(dataLine?.slice("data: ".length) ?? "{}");
    expect(payload.result?.isError).toBe(true);
    expect(payload.result?.content?.[0]?.text).toContain(
      FEEDBACK_NOT_CONFIGURED_MESSAGE
    );
  });
});
