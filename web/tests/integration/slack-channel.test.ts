import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { instruments, slackChannelConfig } from "@/lib/db/schema";
import {
  api,
  clearCapturedSlackMessages,
  closeTestDb,
  getCapturedSlackMessages,
  getTestDb,
  resetDb,
  seedTestUser,
  waitForCapturedSlackMessages,
} from "@/tests/integration/helpers";

// The `/api/v1/settings/slack-channel` surface is admin-only and
// session-only — PATs never pass the gate. The end-to-end
// "DB config → sendSlackMessage" wiring is verified by upserting the
// singleton row directly and asserting the capture server receives the
// payload on run creation.

describe("Slack channel API admin gate", () => {
  let token: string;

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser({ isAdmin: true }));
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("GET /api/v1/settings/slack-channel rejects PAT auth (session required)", async () => {
    const res = await api("/api/v1/settings/slack-channel", { token });
    expect(res.status).toBe(401);
  });

  it("GET /api/v1/settings/slack-channel rejects unauthenticated requests", async () => {
    const res = await api("/api/v1/settings/slack-channel");
    expect(res.status).toBe(401);
  });

  it("PUT /api/v1/settings/slack-channel rejects PAT auth", async () => {
    const res = await api("/api/v1/settings/slack-channel", {
      method: "PUT",
      token,
      body: { webhook_url: "https://hooks.slack.com/services/T/B/x" },
    });
    expect(res.status).toBe(401);
  });

  it("PUT /api/v1/settings/slack-channel rejects unauthenticated requests", async () => {
    const res = await api("/api/v1/settings/slack-channel", {
      method: "PUT",
      body: { webhook_url: "https://hooks.slack.com/services/T/B/x" },
    });
    expect(res.status).toBe(401);
  });
});

describe("Slack channel config flows through sendSlackMessage", () => {
  let token: string;
  const instrumentId = "slack-channel-config-instrument";
  const instrumentDisplayName = "Slack Channel Config Instrument";
  const captureWebhookUrl = `${process.env.__TEST_SLACK_CAPTURE_URL}/webhook`;

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(instruments).values({
      id: instrumentId,
      displayName: instrumentDisplayName,
      status: "active",
    });

    await db
      .insert(slackChannelConfig)
      .values({
        id: true,
        webhookUrl: captureWebhookUrl,
      })
      .onConflictDoUpdate({
        target: slackChannelConfig.id,
        set: { webhookUrl: captureWebhookUrl },
      });
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("run creation posts to the webhook URL from slack_channel_config", async () => {
    await clearCapturedSlackMessages();
    const runId = "slack-channel-run-001";

    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: { run_id: runId, source: "lambda" },
    });
    expect(res.status).toBe(201);

    const messages = await waitForCapturedSlackMessages(1);
    expect(messages[0].text).toContain(instrumentDisplayName);
    expect(messages[0].text).toContain(runId);
  });

  it("sendSlackMessage is a no-op when webhook_url is null", async () => {
    const db = getTestDb();
    await db
      .update(slackChannelConfig)
      .set({ webhookUrl: null })
      .where(eq(slackChannelConfig.id, true));

    await clearCapturedSlackMessages();
    const runId = "slack-channel-run-disabled";

    const res = await api(`/api/v1/instruments/${instrumentId}/runs`, {
      method: "POST",
      token,
      body: { run_id: runId, source: "lambda" },
    });
    expect(res.status).toBe(201);

    const messages = await getCapturedSlackMessages();
    expect(messages.length).toBe(0);

    // Restore the global-setup default for other tests in the suite.
    await db
      .update(slackChannelConfig)
      .set({ webhookUrl: captureWebhookUrl })
      .where(eq(slackChannelConfig.id, true));
  });
});
