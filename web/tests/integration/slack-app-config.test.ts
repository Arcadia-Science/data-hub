import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { slackAppConfig } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedSessionCookie,
  seedTestUser,
} from "@/tests/integration/helpers";

describe("Slack app settings", () => {
  let adminCookie: string;
  let memberCookie: string;
  let adminToken: string;

  beforeAll(async () => {
    await resetDb();
    const admin = await seedTestUser({ isAdmin: true, name: "Admin" });
    const member = await seedTestUser({ isAdmin: false, name: "Member" });
    adminToken = admin.token;
    adminCookie = await seedSessionCookie(admin.userId);
    memberCookie = await seedSessionCookie(member.userId);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  it("rejects a personal access token and a non-admin", async () => {
    const asToken = await api("/api/v1/settings/integrations/slack", {
      token: adminToken,
    });
    expect(asToken.status).toBe(401);

    const asMember = await api("/api/v1/settings/integrations/slack", {
      headers: { Cookie: memberCookie },
    });
    expect(asMember.status).toBe(403);
  });

  it("reports the environment variable without returning the secret", async () => {
    const res = await api("/api/v1/settings/integrations/slack", {
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bot_token).toEqual({ set: true, source: "environment" });
    expect(JSON.stringify(body)).not.toContain("xoxb-test-bot-token");
    expect(body.client_secret).toEqual({ set: false, source: null });
  });

  it("saves an encrypted bot token and never echoes it back", async () => {
    const saved = "xoxb-saved-bot-token";
    const res = await api("/api/v1/settings/integrations/slack", {
      method: "PUT",
      headers: { Cookie: adminCookie },
      body: { bot_token: saved },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bot_token).toEqual({ set: true, source: "database" });
    expect(JSON.stringify(body)).not.toContain(saved);

    const [row] = await getTestDb()
      .select({ botToken: slackAppConfig.botToken })
      .from(slackAppConfig)
      .where(eq(slackAppConfig.id, true));
    expect(row?.botToken?.startsWith("v1:")).toBe(true);
    expect(row?.botToken).not.toContain(saved);
  });

  it("falls back to the environment variable after the saved token is removed", async () => {
    const res = await api("/api/v1/settings/integrations/slack", {
      method: "PUT",
      headers: { Cookie: adminCookie },
      body: { bot_token: null },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bot_token).toEqual({ set: true, source: "environment" });
  });
});
