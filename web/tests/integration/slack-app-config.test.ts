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

  it("rejects a bot token that does not look like one", async () => {
    const res = await api("/api/v1/settings/integrations/slack", {
      method: "PUT",
      headers: { Cookie: adminCookie },
      body: { bot_token: "not-a-bot-token" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("Bot tokens start with xoxb-");
  });

  it("records who saved last", async () => {
    const res = await api("/api/v1/settings/integrations/slack", {
      method: "PUT",
      headers: { Cookie: adminCookie },
      body: { team_id: "T0LASTSAVE" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated_by.name).toBe("Admin");
    expect(new Date(body.updated_at).getTime()).not.toBeNaN();
  });

  it("reports a saved secret the server key cannot open", async () => {
    // Well-formed ciphertext that fails authentication, as after a key change.
    const unreadable = `v1:${"A".repeat(16)}:${"A".repeat(22)}:${"A".repeat(8)}`;
    await getTestDb()
      .update(slackAppConfig)
      .set({ botToken: unreadable, clientSecret: unreadable })
      .where(eq(slackAppConfig.id, true));

    const res = await api("/api/v1/settings/integrations/slack", {
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The bot token still falls back to SLACK_BOT_TOKEN. The client secret
    // has no fallback, so nothing is in use.
    expect(body.bot_token).toEqual({ set: true, source: "unreadable" });
    expect(body.client_secret).toEqual({ set: false, source: "unreadable" });
    expect(JSON.stringify(body)).not.toContain(unreadable);

    const saved = await api("/api/v1/settings/integrations/slack", {
      method: "PUT",
      headers: { Cookie: adminCookie },
      body: { bot_token: "xoxb-replacement-token" },
    });
    expect((await saved.json()).bot_token).toEqual({
      set: true,
      source: "database",
    });

    const cleared = await api("/api/v1/settings/integrations/slack", {
      method: "PUT",
      headers: { Cookie: adminCookie },
      body: { client_secret: null },
    });
    expect((await cleared.json()).client_secret).toEqual({
      set: false,
      source: null,
    });
  });

  it("keeps both changes when two admins save different fields at once", async () => {
    for (let round = 0; round < 5; round++) {
      const [first, second] = await Promise.all([
        api("/api/v1/settings/integrations/slack", {
          method: "PUT",
          headers: { Cookie: adminCookie },
          body: { client_id: `client-${round}` },
        }),
        api("/api/v1/settings/integrations/slack", {
          method: "PUT",
          headers: { Cookie: adminCookie },
          body: { team_id: `T0ROUND${round}` },
        }),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const res = await api("/api/v1/settings/integrations/slack", {
        headers: { Cookie: adminCookie },
      });
      const body = await res.json();
      expect(body.client_id.value).toBe(`client-${round}`);
      expect(body.team_id.value).toBe(`T0ROUND${round}`);
    }
  });
});
