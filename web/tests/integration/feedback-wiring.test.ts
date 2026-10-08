import { createHmac, randomUUID } from "node:crypto";
import { feedbackAttachmentUrl } from "@arcadiascience/app-feedback-toolkit/contract";
import {
  LINEAR_STATES,
  LINEAR_TEAM_ID,
} from "@arcadiascience/app-feedback-toolkit/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  listNotifications,
  notifyFeedbackUpdated,
  updatePreferences,
} from "@/lib/api/notifications";
import { linearIntegrationConfig, slackConnections } from "@/lib/db/schema";
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

// The feedback package has its own tests for the feature. These cover what is
// Data Hub's: its login and admin check, its notifications and Slack, its
// existing URLs, and its real OAuth tokens for MCP.

const WEBHOOK_SECRET = "whsec_wiring";
const SETTINGS = "/api/v1/settings/integrations/linear";

function linearBase(): string {
  const base = process.env.__TEST_LINEAR_API_URL;
  if (!base) {
    throw new Error("__TEST_LINEAR_API_URL is not set");
  }
  return base;
}

async function linearPost(path: string, body: unknown = {}) {
  const res = await fetch(`${linearBase()}/__test/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.ok).toBe(true);
  return res;
}

async function closeIssue(issueId: string) {
  const res = await fetch(`${linearBase()}/__test/issues`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: issueId,
      state: { name: "Done", type: "completed" },
      completedAt: new Date().toISOString(),
    }),
  });
  expect(res.status).toBe(200);
}

// Linear's "moved to Done" update, signed the way Linear signs it.
async function deliverClose(issueId: string) {
  const raw = JSON.stringify({
    action: "update",
    type: "Issue",
    data: { id: issueId, teamId: LINEAR_TEAM_ID },
    updatedFrom: { stateId: LINEAR_STATES.todo.id },
    webhookTimestamp: Date.now(),
  });
  const res = await fetch(
    `${getBaseUrl()}/api/v1/integrations/linear/webhook`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Linear-Delivery": randomUUID(),
        "Linear-Signature": createHmac("sha256", WEBHOOK_SECRET)
          .update(raw)
          .digest("hex"),
      },
      body: raw,
    }
  );
  expect(res.status).toBe(200);
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out after 5 seconds waiting for the condition");
}

async function enableLinear(cookie: string) {
  const connected = await api(`${SETTINGS}/connect`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: { client_id: "client-1", client_secret: "secret" },
  });
  expect(connected.status).toBe(200);
  const saved = await api(SETTINGS, {
    method: "PUT",
    headers: { Cookie: cookie },
    body: {
      webhook_secret: WEBHOOK_SECRET,
      team: { id: LINEAR_TEAM_ID, name: "Data Hub", key: "DH" },
    },
  });
  expect(saved.status).toBe(200);
}

function sendReport(cookie: string, title: string) {
  return api("/api/v1/feedback", {
    method: "POST",
    headers: { Cookie: cookie },
    body: { kind: "bug", title, description: "Stops halfway." },
  });
}

async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown>
) {
  const res = await api("/mcp/v1", {
    method: "POST",
    token,
    headers: { Accept: "application/json, text/event-stream" },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  const text = await res.text();
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine?.slice("data: ".length) ?? "{}") as {
    result?: {
      content?: { text: string }[];
      isError?: boolean;
      structuredContent?: Record<string, any>;
    };
  };
}

async function noteBodies(userId: string): Promise<string[]> {
  return (await listNotifications(userId)).map((note) => note.body ?? "");
}

describe("Feedback in Data Hub", () => {
  beforeAll(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    // Reports notify admins after the response. Truncating while that insert
    // runs deadlocks Postgres, so a busy reset is tried again.
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
    await linearPost("reset");
    await clearCapturedSlackDms();
  });

  it("rejects a personal access token, because a report belongs to a person", async () => {
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

    const settings = await api(SETTINGS, { token: admin.token });
    expect(settings.status).toBe(401);
  });

  it("limits the Linear settings to admins, read from the database", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const member = await seedTestUser();
    const adminCookie = await seedSessionCookie(admin.userId);
    const memberCookie = await seedSessionCookie(member.userId);
    await enableLinear(adminCookie);

    for (const path of [SETTINGS, `${SETTINGS}/options`]) {
      expect(
        (await api(path, { headers: { Cookie: adminCookie } })).status
      ).toBe(200);
      expect(
        (await api(path, { headers: { Cookie: memberCookie } })).status
      ).toBe(403);
    }
    const options = await (
      await api(`${SETTINGS}/options`, { headers: { Cookie: adminCookie } })
    ).json();
    expect(options.teams).toContainEqual(
      expect.objectContaining({ id: LINEAR_TEAM_ID })
    );
  });

  it("tells admins about a new report in the app and in Slack, but not a muted admin", async () => {
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
    await enableLinear(await seedSessionCookie(admin.userId));

    const created = await sendReport(
      await seedSessionCookie(reporter.userId),
      "Export fails"
    );
    expect(created.status).toBe(201);

    await waitFor(async () => (await noteBodies(admin.userId)).length > 0);
    expect(await listNotifications(admin.userId)).toEqual([
      expect.objectContaining({
        type: "feedback_submitted",
        body: "Export fails",
      }),
    ]);
    expect(await listNotifications(muted.userId)).toHaveLength(0);
    await waitFor(async () => (await getCapturedSlackDms()).length > 0);
    expect((await getCapturedSlackDms()).map((dm) => dm.channel)).toContain(
      "U_ADMIN"
    );
  });

  it("tells the reporter in the app and in Slack when the issue closes", async () => {
    const admin = await seedTestUser({
      isAdmin: true,
      email: "webhook-admin@example.com",
    });
    const reporter = await seedTestUser({
      email: "webhook-reporter@example.com",
      name: "Reporter",
    });
    await enableLinear(await seedSessionCookie(admin.userId));
    await getTestDb().insert(slackConnections).values({
      userId: reporter.userId,
      slackUserId: "U_REPORTER",
      slackTeamId: "T_TEST",
      slackTeamName: "Test",
    });
    await updatePreferences(reporter.userId, {
      slackFeedbackUpdatedEnabled: true,
    });

    const created = await sendReport(
      await seedSessionCookie(reporter.userId),
      "Export fails"
    );
    expect(created.status).toBe(201);
    const issueId = (await created.json()).feedback.id as string;

    await closeIssue(issueId);
    await deliverClose(issueId);

    await waitFor(async () => (await noteBodies(reporter.userId)).length > 0);
    expect(await noteBodies(reporter.userId)).toContain(
      'Your feedback "Export fails" was marked Resolved (Done).'
    );
    await waitFor(async () => (await getCapturedSlackDms()).length > 0);
    const dms = await getCapturedSlackDms();
    expect(dms.map((dm) => dm.channel)).toContain("U_REPORTER");
    expect(dms.some((dm) => dm.text.includes("Resolved (Done)"))).toBe(true);
  });

  it("lets the test report say whether the reporter was told, in the app or in Slack", async () => {
    const sender = await seedTestUser({
      isAdmin: true,
      email: "stages-sender@example.com",
    });
    const cookie = await seedSessionCookie(sender.userId);
    await enableLinear(cookie);
    await getTestDb().insert(slackConnections).values({
      userId: sender.userId,
      slackUserId: "U_SENDER",
      slackTeamId: "T_TEST",
      slackTeamName: "Test",
    });

    const created = await api(`${SETTINGS}/test-report`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    expect(created.status).toBe(201);
    const { feedback } = await created.json();
    const status = async () =>
      (
        await api(`${SETTINGS}/test-report/${feedback.id}`, {
          headers: { Cookie: cookie },
        })
      ).json();
    // Each close records its outcome with a new time, so waiting for the time
    // to change tells two `delivered` results apart.
    let lastAt: string | null = null;
    const waitForOutcome = async (outcome: string) => {
      await waitFor(async () => {
        const { notification } = await status();
        return notification?.outcome === outcome && notification.at !== lastAt;
      });
      lastAt = (await status()).notification.at;
    };
    await closeIssue(feedback.id);

    // With in-app and Slack both off, the callback reports `disabled`.
    await updatePreferences(sender.userId, { feedbackUpdatedEnabled: false });
    await deliverClose(feedback.id);
    await waitForOutcome("disabled");
    expect(await listNotifications(sender.userId)).toHaveLength(0);

    // A Slack message on its own counts as telling the reporter.
    await updatePreferences(sender.userId, {
      slackFeedbackUpdatedEnabled: true,
    });
    await deliverClose(feedback.id);
    await waitForOutcome("delivered");
    expect(await listNotifications(sender.userId)).toHaveLength(0);
    expect((await getCapturedSlackDms()).map((dm) => dm.channel)).toContain(
      "U_SENDER"
    );

    // So does the in-app notification on its own.
    await updatePreferences(sender.userId, {
      feedbackUpdatedEnabled: true,
      slackFeedbackUpdatedEnabled: false,
    });
    await deliverClose(feedback.id);
    await waitForOutcome("delivered");
    expect(await listNotifications(sender.userId)).toHaveLength(1);
  });

  it("tells the package nobody was notified when the reporter's account is gone", async () => {
    expect(
      await notifyFeedbackUpdated({
        feedbackId: randomUUID(),
        reporterUserId: randomUUID(),
        title: "Export fails",
        status: "resolved",
        stateName: "Done",
      })
    ).toBe("none");
  });

  it("keeps the report link, the webhook URL, and the review page where Linear and people expect them", async () => {
    const redirect = await fetch(
      `${getBaseUrl()}/feedback/r/user-1/k/bug/11111111-1111-4111-8111-111111111111`,
      { redirect: "manual" }
    );
    expect(redirect.status).toBeGreaterThanOrEqual(300);
    expect(redirect.status).toBeLessThan(400);
    expect(redirect.headers.get("location")).toContain(
      "/settings/feedback?item=11111111-1111-4111-8111-111111111111"
    );

    const webhook = await fetch(
      `${getBaseUrl()}/api/v1/integrations/linear/webhook`,
      { method: "POST", body: "{}" }
    );
    expect(webhook.status).toBe(401);

    const admin = await seedTestUser({ isAdmin: true });
    const page = await fetch(
      `${getBaseUrl()}/settings/feedback?item=not-a-uuid`,
      {
        headers: { cookie: await seedSessionCookie(admin.userId) },
        redirect: "manual",
      }
    );
    expect(page.status).toBe(200);
  });

  it("shows only this deployment's reports, even in a Linear team that others share", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const cookie = await seedSessionCookie(admin.userId);
    await enableLinear(cookie);
    const seed = async (origin: string, title: string) => {
      const id = randomUUID();
      await linearPost("issues", {
        id,
        title,
        state: { name: "Todo", type: "unstarted" },
        attachments: [
          {
            url: feedbackAttachmentUrl({
              origin,
              reporterId: admin.userId,
              kind: "bug",
              issueId: id,
            }),
            metadata: {
              version: 1,
              reporterUserId: admin.userId,
              kind: "bug",
              title,
              description: "Seeded.",
              source: "web",
            },
          },
        ],
      });
    };
    await seed(getBaseUrl(), "Filed here");
    await seed("https://staging.datahub.example", "Filed on staging");

    const body = await (
      await api("/api/v1/feedback", { headers: { Cookie: cookie } })
    ).json();
    expect(body.feedback.map((item: { title: string }) => item.title)).toEqual([
      "Filed here",
    ]);
  });

  it("sends and reads feedback over MCP with a real OAuth token", async () => {
    const admin = await seedTestUser({
      isAdmin: true,
      email: "mcp-admin@example.com",
    });
    await enableLinear(await seedSessionCookie(admin.userId));
    const reporter = await seedTestUser({ email: "mcp-reader@example.com" });
    const stranger = await seedTestUser({ email: "mcp-stranger@example.com" });
    const readToken = await getMcpAccessToken(reporter.userId, "read");

    const sent = await callTool(readToken, "send_feedback", {
      kind: "bug",
      title: "MCP read token",
      description: "A long enough description.",
    });
    expect(sent.result?.isError).not.toBe(true);
    const report = sent.result?.structuredContent?.feedback;
    expect(report.oauthClientName).toBe("Integration Test MCP Client");
    expect(report.reporter.id).toBe(reporter.userId);

    // The reporter reads it back. Someone else cannot, by id or Linear ID.
    for (const id of [report.id, report.linearIssue.identifier]) {
      const own = await callTool(readToken, "get_feedback", { id });
      expect(own.result?.isError).not.toBe(true);
      expect(own.result?.structuredContent?.feedback.activity).toBeNull();
      const denied = await callTool(
        await getMcpAccessToken(stranger.userId, "read"),
        "get_feedback",
        { id }
      );
      expect(denied.result?.isError).toBe(true);
    }

    // An admin can read anyone's report, and gets the admin-only activity.
    const adminRead = await callTool(
      await getMcpAccessToken(admin.userId, "read"),
      "get_feedback",
      { id: report.id }
    );
    expect(adminRead.result?.isError).not.toBe(true);
    expect(adminRead.result?.structuredContent?.feedback.activity).toEqual(
      expect.any(Array)
    );
  });

  it("tells an MCP client that feedback is not set up, in Data Hub's name", async () => {
    const { userId } = await seedTestUser({ email: "mcp-unset@example.com" });
    const token = await getMcpAccessToken(userId, "read");
    const reply = await callTool(token, "send_feedback", {
      kind: "bug",
      title: "Not configured",
      description: "A long enough description.",
    });
    expect(reply.result?.isError).toBe(true);
    expect(reply.result?.content?.[0]?.text).toBe(
      "Feedback isn't set up on this Data Hub."
    );
  });

  it("forgets the Linear setup when an admin disconnects", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const cookie = await seedSessionCookie(admin.userId);
    await enableLinear(cookie);
    const res = await api(SETTINGS, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const rows = await getTestDb()
      .select()
      .from(linearIntegrationConfig)
      .where(eq(linearIntegrationConfig.id, true));
    expect(rows).toHaveLength(0);
  });
});
