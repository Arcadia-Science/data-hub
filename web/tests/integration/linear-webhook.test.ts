import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listNotifications, updatePreferences } from "@/lib/api/notifications";
import { slackConnections } from "@/lib/db/schema";
import {
  api,
  clearCapturedSlackDms,
  closeTestDb,
  getBaseUrl,
  getCapturedSlackDms,
  getTestDb,
  resetDb,
  seedSessionCookie,
  seedTestUser,
} from "@/tests/integration/helpers";
import { LINEAR_TEAM_ID } from "@/tests/integration/linear-fake-server";

const WEBHOOK_SECRET = "whsec_test";

function linearBase(): string {
  const base = process.env.__TEST_LINEAR_API_URL;
  if (!base) {
    throw new Error("__TEST_LINEAR_API_URL is not set");
  }
  return base;
}

function sign(body: string): string {
  return createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
}

function postWebhook(raw: string, signature: string) {
  return fetch(`${getBaseUrl()}/api/v1/integrations/linear/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Linear-Signature": signature,
    },
    body: raw,
  });
}

describe("Linear feedback webhook", () => {
  beforeAll(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
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
    await fetch(`${linearBase()}/__test/reset`, { method: "POST" });
    await clearCapturedSlackDms();
  });

  async function enable(cookie: string) {
    const res = await api("/api/v1/settings/integrations/linear", {
      method: "PUT",
      headers: { Cookie: cookie },
      body: {
        client_id: "client-1",
        client_secret: "secret",
        webhook_secret: WEBHOOK_SECRET,
        team: { id: LINEAR_TEAM_ID, name: "Data Hub" },
      },
    });
    expect(res.status).toBe(200);
  }

  it("rejects a bad signature and an old timestamp", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    await enable(await seedSessionCookie(admin.userId));
    const raw = JSON.stringify({
      type: "Issue",
      action: "update",
      webhookTimestamp: Date.now(),
    });
    const bad = await postWebhook(raw, sign("nope"));
    expect(bad.status).toBe(401);

    const stale = JSON.stringify({
      type: "Issue",
      action: "update",
      webhookTimestamp: Date.now() - 120_000,
    });
    const old = await postWebhook(stale, sign(stale));
    expect(old.status).toBe(401);
  });

  it("notifies the reporter in the app and in Slack when the issue is completed", async () => {
    const admin = await seedTestUser({
      isAdmin: true,
      email: "webhook-admin@example.com",
    });
    const reporter = await seedTestUser({
      email: "webhook-reporter@example.com",
      name: "Reporter",
    });
    await enable(await seedSessionCookie(admin.userId));
    await getTestDb().insert(slackConnections).values({
      userId: reporter.userId,
      slackUserId: "U_REPORTER",
      slackTeamId: "T_TEST",
      slackTeamName: "Test",
    });
    await updatePreferences(reporter.userId, {
      slackFeedbackUpdatedEnabled: true,
    });

    const created = await api("/api/v1/feedback", {
      method: "POST",
      headers: { Cookie: await seedSessionCookie(reporter.userId) },
      body: {
        kind: "bug",
        title: "Export fails",
        description: "Stops halfway.",
      },
    });
    expect(created.status).toBe(201);
    const issueId = (await created.json()).feedback.id as string;

    const patched = await fetch(`${linearBase()}/__test/issues`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: issueId,
        state: { name: "Done", type: "completed" },
        completedAt: new Date().toISOString(),
      }),
    });
    expect(patched.status).toBe(200);

    const raw = JSON.stringify({
      action: "update",
      type: "Issue",
      data: { id: issueId, title: "Export fails" },
      updatedFrom: { stateId: "previous-state" },
      webhookTimestamp: Date.now(),
    });
    const res = await postWebhook(raw, sign(raw));
    expect(res.status).toBe(200);

    const notes = await listNotifications(reporter.userId);
    expect(notes.map((note) => note.body)).toContain(
      'Your feedback "Export fails" was marked Resolved (Done).'
    );
    const dms = await getCapturedSlackDms();
    expect(dms.map((dm) => dm.channel)).toContain("U_REPORTER");
    expect(dms.some((dm) => dm.text.includes("Resolved (Done)"))).toBe(true);
  });
});
