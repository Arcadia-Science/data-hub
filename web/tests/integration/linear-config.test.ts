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
  LINEAR_BAD_CLIENT_ID,
  LINEAR_BAD_CLIENT_SECRET,
  LINEAR_BUG_LABEL_ID,
  LINEAR_FEATURE_LABEL_ID,
  LINEAR_NO_CLIENT_CREDENTIALS_CLIENT_ID,
  LINEAR_OTHER_LABEL_ID,
  LINEAR_OTHER_TEAM_LABEL_ID,
  LINEAR_PROJECT_ID,
  LINEAR_TEAM_ID,
  LINEAR_WORKSPACE_LABEL_ID,
} from "@/tests/integration/linear-fake-server";

const SECOND_TEAM_ID = "99999999-9999-4999-8999-999999999999";
const SECOND_PROJECT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECOND_BUG_LABEL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CLIENT_SECRET = "lin_client_secret_value";
const SETTINGS = "/api/v1/settings/integrations/linear";

describe("Linear integration settings", () => {
  let adminCookie: string;
  let memberCookie: string;
  let adminToken: string;

  async function put(body: Record<string, unknown>) {
    return await api(SETTINGS, {
      method: "PUT",
      headers: { Cookie: adminCookie },
      body,
    });
  }

  async function testConnection(body: Record<string, unknown> = {}) {
    return await api(`${SETTINGS}/test`, {
      method: "POST",
      headers: { Cookie: adminCookie },
      body,
    });
  }

  async function current() {
    const res = await api(SETTINGS, { headers: { Cookie: adminCookie } });
    expect(res.status).toBe(200);
    return await res.json();
  }

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
    const asToken = await api(SETTINGS, { token: adminToken });
    expect(asToken.status).toBe(401);

    const asMember = await api(SETTINGS, { headers: { Cookie: memberCookie } });
    expect(asMember.status).toBe(403);
  });

  it("starts empty", async () => {
    const body = await current();
    expect(body.client_id).toEqual({ set: false, source: null, value: null });
    expect(body.client_secret).toEqual({ set: false, source: null });
    expect(body.team).toBeNull();
    expect(body.labels).toEqual({
      bug: null,
      feature_request: null,
      other: null,
    });
    expect(body.last_webhook_at).toBeNull();
    expect(body.updated_at).toBeNull();
  });

  it("rejects a body that sets nothing", async () => {
    const res = await put({ team_id: LINEAR_TEAM_ID });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("saves encrypted secrets and does not return them", async () => {
    const webhook = "lin_webhook_secret_value";
    const res = await put({
      client_id: "client-1",
      client_secret: CLIENT_SECRET,
      webhook_secret: webhook,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.client_id).toEqual({
      set: true,
      source: "database",
      value: "client-1",
    });
    expect(body.client_secret).toEqual({ set: true, source: "database" });
    expect(body.webhook_secret).toEqual({ set: true, source: "database" });
    expect(body.updated_by.name).toBe("Admin");
    expect(JSON.stringify(body)).not.toContain(CLIENT_SECRET);
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
    const test = await testConnection();
    expect(test.status).toBe(200);
    expect(await test.json()).toEqual({ organization_name: "Test Org" });

    const teams = await api(`${SETTINGS}/options`, {
      headers: { Cookie: adminCookie },
    });
    expect(teams.status).toBe(200);
    expect(await teams.json()).toMatchObject({
      teams: [{ id: LINEAR_TEAM_ID, name: "Data Hub" }],
      projects: null,
      labels: null,
    });

    const options = await api(`${SETTINGS}/options?team_id=${LINEAR_TEAM_ID}`, {
      headers: { Cookie: adminCookie },
    });
    expect(options.status).toBe(200);
    const optionsBody = await options.json();
    expect(optionsBody.projects).toEqual([
      { id: LINEAR_PROJECT_ID, name: "Feedback" },
    ]);
    // The team's labels plus the workspace-level one, but not another team's.
    expect(optionsBody.labels).toEqual([
      { id: LINEAR_BUG_LABEL_ID, name: "Bug" },
      { id: LINEAR_FEATURE_LABEL_ID, name: "Feature" },
      { id: LINEAR_OTHER_LABEL_ID, name: "Other" },
      { id: LINEAR_WORKSPACE_LABEL_ID, name: "Triage" },
    ]);
    expect(JSON.stringify(optionsBody)).not.toContain(
      LINEAR_OTHER_TEAM_LABEL_ID
    );
  });

  it("returns 404 for a team Linear does not know", async () => {
    const res = await api(`${SETTINGS}/options?team_id=${SECOND_TEAM_ID}`, {
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
  });

  it("saves the team, project, and labels", async () => {
    const res = await put({
      team: { id: LINEAR_TEAM_ID, name: "Data Hub" },
      project: { id: LINEAR_PROJECT_ID, name: "Feedback" },
      labels: {
        bug: { id: LINEAR_BUG_LABEL_ID, name: "Bug" },
        feature_request: { id: LINEAR_FEATURE_LABEL_ID, name: "Feature" },
        other: { id: LINEAR_OTHER_LABEL_ID, name: "Other" },
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.team).toEqual({ id: LINEAR_TEAM_ID, name: "Data Hub" });
    expect(body.project).toEqual({ id: LINEAR_PROJECT_ID, name: "Feedback" });
    expect(body.labels.bug).toEqual({ id: LINEAR_BUG_LABEL_ID, name: "Bug" });
    expect(body.client_secret).toEqual({ set: true, source: "database" });
  });

  it("keeps the project and labels chosen in the same save as a team change", async () => {
    const res = await put({
      team: { id: SECOND_TEAM_ID, name: "Other Team" },
      project: { id: SECOND_PROJECT_ID, name: "Triage" },
      labels: { bug: { id: SECOND_BUG_LABEL_ID, name: "Defect" } },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.team).toEqual({ id: SECOND_TEAM_ID, name: "Other Team" });
    expect(body.project).toEqual({ id: SECOND_PROJECT_ID, name: "Triage" });
    expect(body.labels.bug).toEqual({
      id: SECOND_BUG_LABEL_ID,
      name: "Defect",
    });
    // Saved for the old team and not sent again, so they are cleared.
    expect(body.labels.feature_request).toBeNull();
    expect(body.labels.other).toBeNull();
  });

  it("clears the project and labels when only the team changes", async () => {
    const res = await put({ team: { id: LINEAR_TEAM_ID, name: "Data Hub" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.team).toEqual({ id: LINEAR_TEAM_ID, name: "Data Hub" });
    expect(body.project).toBeNull();
    expect(body.labels).toEqual({
      bug: null,
      feature_request: null,
      other: null,
    });
  });

  it("keeps other choices when one project or label changes on the same team", async () => {
    await put({
      project: { id: LINEAR_PROJECT_ID, name: "Feedback" },
      labels: {
        bug: { id: LINEAR_BUG_LABEL_ID, name: "Bug" },
        other: { id: LINEAR_OTHER_LABEL_ID, name: "Other" },
      },
    });
    const res = await put({ labels: { other: null } });
    const body = await res.json();
    expect(body.project).toEqual({ id: LINEAR_PROJECT_ID, name: "Feedback" });
    expect(body.labels.bug).toEqual({ id: LINEAR_BUG_LABEL_ID, name: "Bug" });
    expect(body.labels.other).toBeNull();
  });

  it("clears everything when the team is removed", async () => {
    const res = await put({ team: null });
    const body = await res.json();
    expect(body.team).toBeNull();
    expect(body.project).toBeNull();
    expect(body.labels.bug).toBeNull();
  });

  it("keeps both changes when two admins save different fields at once", async () => {
    await put({ team: { id: LINEAR_TEAM_ID, name: "Data Hub" } });
    for (let round = 0; round < 5; round++) {
      const [first, second] = await Promise.all([
        put({ project: { id: LINEAR_PROJECT_ID, name: "Feedback" } }),
        put({ labels: { bug: { id: LINEAR_BUG_LABEL_ID, name: "Bug" } } }),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      const body = await current();
      expect(body.project).toEqual({ id: LINEAR_PROJECT_ID, name: "Feedback" });
      expect(body.labels.bug).toEqual({ id: LINEAR_BUG_LABEL_ID, name: "Bug" });

      await put({ project: null, labels: { bug: null } });
    }
  });

  it("returns 502 when Linear rejects the credentials", async () => {
    const res = await testConnection({
      client_id: LINEAR_BAD_CLIENT_ID,
      client_secret: "nope",
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("LINEAR_UNAVAILABLE");
  });

  it("fails the test for the same client ID with a wrong secret, even after a good test", async () => {
    // A good test first, so a token for this client ID is cached.
    expect((await testConnection()).status).toBe(200);

    const res = await testConnection({
      client_id: "client-1",
      client_secret: LINEAR_BAD_CLIENT_SECRET,
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toContain(
      "Linear rejected the app credentials"
    );
  });

  it("stops using the old token once a new secret is saved", async () => {
    expect((await testConnection()).status).toBe(200);

    await put({ client_secret: LINEAR_BAD_CLIENT_SECRET });
    expect((await testConnection()).status).toBe(502);

    await put({ client_secret: CLIENT_SECRET });
    expect((await testConnection()).status).toBe(200);
  });

  it("tells the admin to turn on client credentials when the app has them off", async () => {
    const res = await testConnection({
      client_id: LINEAR_NO_CLIENT_CREDENTIALS_CLIENT_ID,
      client_secret: "any-secret",
    });
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toContain(
      "turn on client credentials tokens"
    );
  });

  it("reports a saved secret the server key cannot open", async () => {
    // Well-formed ciphertext that fails authentication, as after a key change.
    const unreadable = `v1:${"A".repeat(16)}:${"A".repeat(22)}:${"A".repeat(8)}`;
    await getTestDb()
      .update(linearIntegrationConfig)
      .set({ clientSecret: unreadable, webhookSecret: unreadable })
      .where(eq(linearIntegrationConfig.id, true));

    const body = await current();
    expect(body.client_secret).toEqual({ set: false, source: "unreadable" });
    expect(body.webhook_secret).toEqual({ set: false, source: "unreadable" });
    expect(JSON.stringify(body)).not.toContain(unreadable);

    // Nothing usable is saved, so a test with nothing typed asks for a save.
    const test = await testConnection();
    expect(test.status).toBe(400);

    const saved = await put({ client_secret: CLIENT_SECRET });
    expect((await saved.json()).client_secret).toEqual({
      set: true,
      source: "database",
    });
  });
});
