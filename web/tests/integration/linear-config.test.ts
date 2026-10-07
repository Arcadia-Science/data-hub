import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { linearIntegrationConfig } from "@/lib/db/schema";
import { backfillLinearSetup } from "@/lib/linear/config";
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

  async function connect(body: Record<string, unknown>) {
    return await api(`${SETTINGS}/connect`, {
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
    expect(body.webhook_rejections).toBe(0);
    expect(body.workspace_name).toBeNull();
    expect(body.secrets_key).toBe("ok");
    expect(body.updated_at).toBeNull();
  });

  it("rejects a body that sets nothing", async () => {
    const res = await put({ team_id: LINEAR_TEAM_ID });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects credentials sent to the settings update", async () => {
    // Credentials are saved only through `/connect`, which checks them first.
    const res = await put({
      client_id: "sneaky",
      client_secret: "sneaky",
      team: { id: LINEAR_TEAM_ID, name: "Data Hub" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("VALIDATION_ERROR");
    expect((await current()).team).toBeNull();
  });

  it("saves encrypted secrets and does not return them", async () => {
    const webhook = "lin_webhook_secret_value";
    const connected = await connect({
      client_id: "client-1",
      client_secret: CLIENT_SECRET,
    });
    expect(connected.status).toBe(200);
    expect((await connected.json()).workspace_name).toBe("Test Org");
    const res = await put({ webhook_secret: webhook });
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

  it("lists teams, projects, and labels", async () => {
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
      {
        id: LINEAR_PROJECT_ID,
        name: "Feedback",
        url: "https://linear.app/test-org/project/feedback",
      },
    ]);
    // The team's labels plus the workspace-level one, but not another team's.
    expect(optionsBody.labels).toEqual([
      { id: LINEAR_BUG_LABEL_ID, name: "Bug", color: "#eb5757" },
      { id: LINEAR_FEATURE_LABEL_ID, name: "Feature", color: "#bb87fc" },
      { id: LINEAR_OTHER_LABEL_ID, name: "Other", color: "#4ea7fc" },
      { id: LINEAR_WORKSPACE_LABEL_ID, name: "Triage", color: "#f2c94c" },
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

  it("resets the last update when the team changes and the rejections when a new signing secret is saved", async () => {
    const stamp = new Date("2026-01-01T00:00:00.000Z");
    await put({
      team: { id: LINEAR_TEAM_ID, name: "Data Hub" },
      webhook_secret: "lin_webhook_secret_one",
    });
    await getTestDb()
      .update(linearIntegrationConfig)
      .set({
        lastWebhookAt: stamp,
        webhookRejections: 3,
        lastWebhookRejectedAt: stamp,
        lastWebhookRejectionReason: "signature",
      })
      .where(eq(linearIntegrationConfig.id, true));

    // Saving the same team leaves both alone.
    let body = await (
      await put({ team: { id: LINEAR_TEAM_ID, name: "Data Hub" } })
    ).json();
    expect(body.last_webhook_at).toBe(stamp.toISOString());
    expect(body.webhook_rejections).toBe(3);

    // A new signing secret clears the rejections, not the last update.
    body = await (
      await put({ webhook_secret: "lin_webhook_secret_two" })
    ).json();
    expect(body.webhook_rejections).toBe(0);
    expect(body.last_webhook_rejected_at).toBeNull();
    expect(body.last_webhook_rejection_reason).toBeNull();
    expect(body.last_webhook_at).toBe(stamp.toISOString());

    // A different team no longer counts the old team's last update.
    body = await (
      await put({ team: { id: SECOND_TEAM_ID, name: "Other Team" } })
    ).json();
    expect(body.last_webhook_at).toBeNull();
  });

  it("does not save credentials Linear rejects", async () => {
    const before = await current();
    const res = await connect({
      client_id: LINEAR_BAD_CLIENT_ID,
      client_secret: "nope",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("LINEAR_CREDENTIALS_REJECTED");
    expect((await current()).client_id).toEqual(before.client_id);
  });

  it("does not replace a working secret with a rejected one", async () => {
    const res = await connect({
      client_id: "client-1",
      client_secret: LINEAR_BAD_CLIENT_SECRET,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain(
      "Linear rejected the app credentials"
    );
    const options = await api(`${SETTINGS}/options`, {
      headers: { Cookie: adminCookie },
    });
    expect(options.status).toBe(200);
  });

  it("tells the admin to turn on client credentials when the app has them off", async () => {
    const res = await connect({
      client_id: LINEAR_NO_CLIENT_CREDENTIALS_CLIENT_ID,
      client_secret: "any-secret",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("LINEAR_CLIENT_CREDENTIALS_OFF");
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

    const saved = await connect({
      client_id: "client-1",
      client_secret: CLIENT_SECRET,
    });
    expect((await saved.json()).client_secret).toEqual({
      set: true,
      source: "database",
    });
  });

  it("fills in the workspace, team key, and project link on a setup saved before they were stored", async () => {
    await put({
      team: { id: LINEAR_TEAM_ID, name: "Data Hub" },
      project: { id: LINEAR_PROJECT_ID, name: "Feedback" },
    });
    await getTestDb()
      .update(linearIntegrationConfig)
      .set({
        workspaceId: null,
        workspaceName: null,
        workspaceUrlKey: null,
        teamKey: null,
        projectUrl: null,
      })
      .where(eq(linearIntegrationConfig.id, true));
    const before = await current();
    expect(before.workspace_name).toBeNull();
    expect(before.team_key).toBeNull();
    expect(before.project_url).toBeNull();

    await backfillLinearSetup();

    const after = await current();
    expect(after.workspace_name).toBe("Test Org");
    expect(after.workspace_url_key).toBe("test-org");
    expect(after.team_key).toBe("DH");
    expect(after.project_url).toBe(
      "https://linear.app/test-org/project/feedback"
    );
    // The page's own save time does not move when the page fills these in.
    expect(after.updated_at).toBe(before.updated_at);
  });

  it("leaves the setup alone when Linear can't be reached", async () => {
    await getTestDb()
      .update(linearIntegrationConfig)
      .set({ workspaceId: null, workspaceName: null, teamKey: null })
      .where(eq(linearIntegrationConfig.id, true));
    const original = process.env.__TEST_LINEAR_API_URL;
    // Nothing listens on port 9, so `fetch` rejects with a network error.
    process.env.__TEST_LINEAR_API_URL = "http://127.0.0.1:9";
    try {
      await expect(backfillLinearSetup()).resolves.toBeUndefined();
    } finally {
      process.env.__TEST_LINEAR_API_URL = original;
    }
    const body = await current();
    expect(body.workspace_name).toBeNull();
    expect(body.team_key).toBeNull();
    expect(body.client_secret).toEqual({ set: true, source: "database" });

    await backfillLinearSetup();
    expect((await current()).workspace_name).toBe("Test Org");
  });

  it("refuses a different workspace until the admin confirms, then clears the setup", async () => {
    await put({
      team: { id: LINEAR_TEAM_ID, name: "Data Hub", key: "DH" },
      project: { id: LINEAR_PROJECT_ID, name: "Feedback" },
      labels: { bug: { id: LINEAR_BUG_LABEL_ID, name: "Bug" } },
      webhook_secret: "lin_webhook_secret_value",
    });
    await getTestDb()
      .update(linearIntegrationConfig)
      .set({
        lastWebhookAt: new Date(),
        webhookRejections: 2,
        lastWebhookRejectedAt: new Date(),
        lastWebhookRejectionReason: "signature",
      })
      .where(eq(linearIntegrationConfig.id, true));
    await fetch(`${process.env.__TEST_LINEAR_API_URL}/__test/workspace`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: "org-2",
        name: "Other Org",
        urlKey: "other-org",
      }),
    });

    const refused = await connect({
      client_id: "client-2",
      client_secret: "another-secret",
    });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error.details.workspace_name).toBe(
      "Other Org"
    );
    // Refusing changes nothing.
    const untouched = await current();
    expect(untouched.team).toEqual({ id: LINEAR_TEAM_ID, name: "Data Hub" });
    expect(untouched.project).toEqual({
      id: LINEAR_PROJECT_ID,
      name: "Feedback",
    });
    expect(untouched.webhook_rejections).toBe(2);

    const confirmed = await connect({
      client_id: "client-2",
      client_secret: "another-secret",
      confirm_workspace_change: true,
    });
    expect(confirmed.status).toBe(200);
    const body = await confirmed.json();
    expect(body.workspace_name).toBe("Other Org");
    expect(body.team).toBeNull();
    expect(body.team_key).toBeNull();
    expect(body.project).toBeNull();
    expect(body.project_url).toBeNull();
    expect(body.labels).toEqual({
      bug: null,
      feature_request: null,
      other: null,
    });
    expect(body.webhook_secret).toEqual({ set: false, source: null });
    expect(body.last_webhook_at).toBeNull();
    expect(body.webhook_rejections).toBe(0);
    expect(body.last_webhook_rejected_at).toBeNull();
    expect(body.last_webhook_rejection_reason).toBeNull();
  });

  it("disconnects and turns feedback off", async () => {
    const res = await api(SETTINGS, {
      method: "DELETE",
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.client_secret).toEqual({ set: false, source: null });
    expect(body.team).toBeNull();
    expect(body.workspace_name).toBeNull();
  });
});
