import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linearIntegrationConfig } from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedSessionCookie,
  seedTestUser,
} from "@/tests/integration/helpers";
import {
  LINEAR_BUG_LABEL_ID,
  LINEAR_FEATURE_LABEL_ID,
  LINEAR_OTHER_LABEL_ID,
  LINEAR_PROJECT_ID,
  LINEAR_TEAM_ID,
} from "@/tests/integration/linear-fake-server";

describe("Linear integration settings", () => {
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
    const asToken = await api("/api/v1/settings/integrations/linear", {
      token: adminToken,
    });
    expect(asToken.status).toBe(401);

    const asMember = await api("/api/v1/settings/integrations/linear", {
      headers: { Cookie: memberCookie },
    });
    expect(asMember.status).toBe(403);
  });

  it("saves encrypted secrets and does not return them", async () => {
    const secret = "lin_client_secret_value";
    const webhook = "lin_webhook_secret_value";
    const res = await api("/api/v1/settings/integrations/linear", {
      method: "PUT",
      headers: { Cookie: adminCookie },
      body: {
        client_id: "client-1",
        client_secret: secret,
        webhook_secret: webhook,
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.client_id).toBe("client-1");
    expect(body.client_secret).toEqual({ set: true });
    expect(body.webhook_secret).toEqual({ set: true });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain(webhook);

    const [row] = await getTestDb()
      .select({
        clientSecret: linearIntegrationConfig.clientSecret,
        webhookSecret: linearIntegrationConfig.webhookSecret,
      })
      .from(linearIntegrationConfig)
      .where(eq(linearIntegrationConfig.id, true));
    expect(row?.clientSecret?.startsWith("v1:")).toBe(true);
    expect(row?.webhookSecret?.startsWith("v1:")).toBe(true);
  });

  it("tests the connection and lists teams, projects, and labels", async () => {
    const test = await api("/api/v1/settings/integrations/linear/test", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: {},
    });
    expect(test.status).toBe(200);
    expect(await test.json()).toEqual({ organization_name: "Test Org" });

    const teams = await api("/api/v1/settings/integrations/linear/options", {
      headers: { Cookie: adminCookie },
    });
    expect(teams.status).toBe(200);
    expect(await teams.json()).toMatchObject({
      teams: [{ id: LINEAR_TEAM_ID, name: "Data Hub" }],
      projects: null,
      labels: null,
    });

    const options = await api(
      `/api/v1/settings/integrations/linear/options?team_id=${LINEAR_TEAM_ID}`,
      { headers: { Cookie: adminCookie } }
    );
    expect(options.status).toBe(200);
    const optionsBody = await options.json();
    expect(optionsBody.projects).toEqual([
      { id: LINEAR_PROJECT_ID, name: "Feedback" },
    ]);
    expect(optionsBody.labels).toEqual([
      { id: LINEAR_BUG_LABEL_ID, name: "Bug" },
      { id: LINEAR_FEATURE_LABEL_ID, name: "Feature" },
      { id: LINEAR_OTHER_LABEL_ID, name: "Other" },
    ]);
  });

  it("saves the team, project, and labels", async () => {
    const res = await api("/api/v1/settings/integrations/linear", {
      method: "PUT",
      headers: { Cookie: adminCookie },
      body: {
        team_id: LINEAR_TEAM_ID,
        team_name: "Data Hub",
        project_id: LINEAR_PROJECT_ID,
        project_name: "Feedback",
        bug_label_id: LINEAR_BUG_LABEL_ID,
        bug_label_name: "Bug",
        feature_label_id: LINEAR_FEATURE_LABEL_ID,
        feature_label_name: "Feature",
        other_label_id: LINEAR_OTHER_LABEL_ID,
        other_label_name: "Other",
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.team).toEqual({ id: LINEAR_TEAM_ID, name: "Data Hub" });
    expect(body.project).toEqual({ id: LINEAR_PROJECT_ID, name: "Feedback" });
    expect(body.labels.bug).toEqual({ id: LINEAR_BUG_LABEL_ID, name: "Bug" });
    expect(body.client_secret).toEqual({ set: true });
  });

  it("returns 502 when Linear rejects the credentials", async () => {
    const res = await api("/api/v1/settings/integrations/linear/test", {
      method: "POST",
      headers: { Cookie: adminCookie },
      body: { client_id: "fail-linear", client_secret: "nope" },
    });
    expect(res.status).toBe(502);
  });
});
