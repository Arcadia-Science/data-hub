import { createHmac, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listNotifications, updatePreferences } from "@/lib/api/notifications";
import { linearIntegrationConfig, slackConnections } from "@/lib/db/schema";
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
import {
  LINEAR_STATES,
  LINEAR_TEAM_ID,
} from "@/tests/integration/linear-fake-server";

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

function postWebhook(
  raw: string,
  signature: string,
  deliveryId: string = randomUUID()
) {
  return fetch(`${getBaseUrl()}/api/v1/integrations/linear/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Linear-Delivery": deliveryId,
      "Linear-Signature": signature,
    },
    body: raw,
  });
}

interface LinearState {
  name: string;
  type: string;
}

function stateChange(issueId: string, previous: { id: string }): string {
  return JSON.stringify({
    action: "update",
    type: "Issue",
    data: { id: issueId, title: "Export fails", teamId: LINEAR_TEAM_ID },
    updatedFrom: { stateId: previous.id },
    webhookTimestamp: Date.now(),
  });
}

async function moveIssue(issueId: string, state: LinearState) {
  const patched = await fetch(`${linearBase()}/__test/issues`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: issueId,
      state: { name: state.name, type: state.type },
      completedAt: state.type === "completed" ? new Date().toISOString() : null,
      canceledAt: state.type === "canceled" ? new Date().toISOString() : null,
    }),
  });
  expect(patched.status).toBe(200);
}

// The handler replies before it writes, so results show up a moment later.
async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the webhook to finish");
}

// Gives work that should not happen time to show up, so a test that expects
// nothing more cannot pass just because it looked too early.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 400));
}

async function lastWebhookAt(): Promise<Date | null> {
  const [row] = await getTestDb().select().from(linearIntegrationConfig);
  return row?.lastWebhookAt ?? null;
}

async function noteBodies(userId: string): Promise<string[]> {
  return (await listNotifications(userId)).map((note) => note.body ?? "");
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
    const connected = await api(
      "/api/v1/settings/integrations/linear/connect",
      {
        method: "POST",
        headers: { Cookie: cookie },
        body: { client_id: "client-1", client_secret: "secret" },
      }
    );
    expect(connected.status).toBe(200);
    const res = await api("/api/v1/settings/integrations/linear", {
      method: "PUT",
      headers: { Cookie: cookie },
      body: {
        webhook_secret: WEBHOOK_SECRET,
        team: { id: LINEAR_TEAM_ID, name: "Data Hub", key: "DH" },
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
      data: { id: issueId, title: "Export fails", teamId: LINEAR_TEAM_ID },
      updatedFrom: { stateId: "previous-state" },
      webhookTimestamp: Date.now(),
    });
    const res = await postWebhook(raw, sign(raw));
    expect(res.status).toBe(200);

    await waitFor(async () => (await noteBodies(reporter.userId)).length > 0);
    expect(await noteBodies(reporter.userId)).toContain(
      'Your feedback "Export fails" was marked Resolved (Done).'
    );
    await waitFor(async () => (await getCapturedSlackDms()).length > 0);
    const dms = await getCapturedSlackDms();
    expect(dms.map((dm) => dm.channel)).toContain("U_REPORTER");
    expect(dms.some((dm) => dm.text.includes("Resolved (Done)"))).toBe(true);
  });

  // An admin who set Linear up and a reporter with a report that is `Todo`.
  async function seedOpenReport() {
    const admin = await seedTestUser({
      isAdmin: true,
      email: "admin@example.com",
    });
    const reporter = await seedTestUser({
      email: "reporter@example.com",
      name: "Reporter",
    });
    await enable(await seedSessionCookie(admin.userId));
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
    // The admin's "new report" notification is written after the response.
    await waitFor(async () => (await noteBodies(admin.userId)).length > 0);
    await moveIssue(issueId, LINEAR_STATES.todo);
    return { issueId, reporter };
  }

  it("does not notify again when a completed issue moves to another completed state", async () => {
    const { issueId, reporter } = await seedOpenReport();

    await moveIssue(issueId, LINEAR_STATES.done);
    const done = stateChange(issueId, LINEAR_STATES.todo);
    expect((await postWebhook(done, sign(done))).status).toBe(200);
    await waitFor(async () => (await noteBodies(reporter.userId)).length === 1);

    await moveIssue(issueId, LINEAR_STATES.released);
    const released = stateChange(issueId, LINEAR_STATES.done);
    expect((await postWebhook(released, sign(released))).status).toBe(200);
    await settle();

    expect(await noteBodies(reporter.userId)).toEqual([
      'Your feedback "Export fails" was marked Resolved (Done).',
    ]);
  });

  it("notifies again when a closed issue is reopened and closed again", async () => {
    const { issueId, reporter } = await seedOpenReport();

    await moveIssue(issueId, LINEAR_STATES.done);
    const first = stateChange(issueId, LINEAR_STATES.todo);
    await postWebhook(first, sign(first));
    await waitFor(async () => (await noteBodies(reporter.userId)).length === 1);

    await moveIssue(issueId, LINEAR_STATES.todo);
    const reopened = stateChange(issueId, LINEAR_STATES.done);
    await postWebhook(reopened, sign(reopened));
    await settle();
    expect(await noteBodies(reporter.userId)).toHaveLength(1);

    await moveIssue(issueId, LINEAR_STATES.released);
    const closedAgain = stateChange(issueId, LINEAR_STATES.todo);
    await postWebhook(closedAgain, sign(closedAgain));
    await waitFor(async () => (await noteBodies(reporter.userId)).length === 2);
  });

  it("sends one notification when Linear delivers the same event twice", async () => {
    const { issueId, reporter } = await seedOpenReport();
    await moveIssue(issueId, LINEAR_STATES.done);
    const raw = stateChange(issueId, LINEAR_STATES.todo);
    const deliveryId = randomUUID();

    const responses = await Promise.all([
      postWebhook(raw, sign(raw), deliveryId),
      postWebhook(raw, sign(raw), deliveryId),
    ]);
    expect(responses.map((res) => res.status)).toEqual([200, 200]);
    await waitFor(async () => (await noteBodies(reporter.userId)).length > 0);
    await settle();

    expect(await noteBodies(reporter.userId)).toHaveLength(1);
  });

  it("tells the reporter when the issue is closed as a duplicate", async () => {
    const { issueId, reporter } = await seedOpenReport();
    await moveIssue(issueId, LINEAR_STATES.duplicate);
    const raw = stateChange(issueId, LINEAR_STATES.todo);
    expect((await postWebhook(raw, sign(raw))).status).toBe(200);

    await waitFor(async () => (await noteBodies(reporter.userId)).length > 0);
    expect(await noteBodies(reporter.userId)).toEqual([
      'Your feedback "Export fails" was marked Declined (Duplicate).',
    ]);
  });

  it("ignores an issue that is not a Data Hub report", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    await enable(await seedSessionCookie(admin.userId));
    const seeded = await fetch(`${linearBase()}/__test/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Internal engineering issue",
        state: { name: "Done", type: "completed" },
      }),
    });
    const { id } = (await seeded.json()) as { id: string };
    const raw = stateChange(id, LINEAR_STATES.todo);
    expect((await postWebhook(raw, sign(raw))).status).toBe(200);

    await waitFor(async () => (await lastWebhookAt()) !== null);
    expect(await noteBodies(admin.userId)).toEqual([]);
  });

  it("answers 502 when Linear cannot be reached, then notifies on the resend", async () => {
    const { issueId, reporter } = await seedOpenReport();
    await moveIssue(issueId, LINEAR_STATES.done);
    const raw = stateChange(issueId, LINEAR_STATES.todo);
    const deliveryId = randomUUID();

    await fetch(`${linearBase()}/__test/rate-limit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const failed = await postWebhook(raw, sign(raw), deliveryId);
    expect(failed.status).toBe(502);
    expect((await failed.json()).error.code).toBe("LINEAR_UNAVAILABLE");
    await settle();
    expect(await noteBodies(reporter.userId)).toEqual([]);

    await fetch(`${linearBase()}/__test/rate-limit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const resent = await postWebhook(raw, sign(raw), deliveryId);
    expect(resent.status).toBe(200);
    await waitFor(async () => (await noteBodies(reporter.userId)).length === 1);
  });

  it("records the last delivery without changing the last-saved time", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    await enable(await seedSessionCookie(admin.userId));
    const [saved] = await getTestDb().select().from(linearIntegrationConfig);
    expect(saved.lastWebhookAt).toBeNull();
    // A delivery that arrives at least a moment after the save.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const raw = JSON.stringify({
      action: "create",
      type: "Issue",
      data: { id: randomUUID(), teamId: LINEAR_TEAM_ID },
      webhookTimestamp: Date.now(),
    });
    expect((await postWebhook(raw, sign(raw))).status).toBe(200);
    await waitFor(async () => (await lastWebhookAt()) !== null);

    const [after] = await getTestDb().select().from(linearIntegrationConfig);
    expect(after.updatedAt.getTime()).toBe(saved.updatedAt.getTime());
  });

  it("waits for Linear again after a new signing secret is saved", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const cookie = await seedSessionCookie(admin.userId);
    await enable(cookie);
    const update = () =>
      JSON.stringify({
        action: "update",
        type: "Issue",
        data: { id: randomUUID(), teamId: LINEAR_TEAM_ID },
        webhookTimestamp: Date.now(),
      });

    const first = update();
    expect((await postWebhook(first, sign(first))).status).toBe(200);
    await waitFor(async () => (await lastWebhookAt()) !== null);

    const newSecret = "whsec_replaced";
    const saved = await api("/api/v1/settings/integrations/linear", {
      method: "PUT",
      headers: { Cookie: cookie },
      body: { webhook_secret: newSecret },
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).last_webhook_at).toBeNull();
    expect(await lastWebhookAt()).toBeNull();

    const signedWithOld = update();
    expect((await postWebhook(signedWithOld, sign(signedWithOld))).status).toBe(
      401
    );
    const signedWithNew = update();
    const newSignature = createHmac("sha256", newSecret)
      .update(signedWithNew)
      .digest("hex");
    expect((await postWebhook(signedWithNew, newSignature)).status).toBe(200);
    await waitFor(async () => (await lastWebhookAt()) !== null);
  });

  it("counts a rejected delivery from Linear for this workspace, then clears it", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    await enable(await seedSessionCookie(admin.userId));
    const [saved] = await getTestDb().select().from(linearIntegrationConfig);
    await getTestDb()
      .update(linearIntegrationConfig)
      .set({ workspaceId: "org-1" })
      .where(eq(linearIntegrationConfig.id, true));

    const raw = JSON.stringify({
      type: "Issue",
      action: "update",
      organizationId: "org-1",
      webhookTimestamp: Date.now(),
    });
    const linearIp = "35.231.147.226";
    const rejected = await fetch(
      `${getBaseUrl()}/api/v1/integrations/linear/webhook`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Linear-Signature": sign("nope"),
          "x-real-ip": linearIp,
        },
        body: raw,
      }
    );
    expect(rejected.status).toBe(401);
    await waitFor(async () => {
      const [row] = await getTestDb().select().from(linearIntegrationConfig);
      return row.webhookRejections === 1;
    });

    const stranger = await fetch(
      `${getBaseUrl()}/api/v1/integrations/linear/webhook`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Linear-Signature": sign("nope"),
          "x-real-ip": "203.0.113.8",
        },
        body: raw,
      }
    );
    expect(stranger.status).toBe(401);
    await settle();
    const [afterStranger] = await getTestDb()
      .select()
      .from(linearIntegrationConfig);
    expect(afterStranger.webhookRejections).toBe(1);

    const otherTeam = JSON.stringify({
      action: "update",
      type: "Issue",
      data: {
        id: randomUUID(),
        teamId: "99999999-9999-4999-8999-999999999999",
      },
      webhookTimestamp: Date.now(),
    });
    expect((await postWebhook(otherTeam, sign(otherTeam))).status).toBe(200);
    await waitFor(async () => {
      const [row] = await getTestDb().select().from(linearIntegrationConfig);
      return row.webhookRejections === 0 && row.lastWebhookAt === null;
    });
    expect(saved.updatedAt).toBeTruthy();
  });
});
