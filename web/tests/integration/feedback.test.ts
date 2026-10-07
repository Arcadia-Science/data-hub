import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FEEDBACK_NOT_CONFIGURED_MESSAGE,
  FEEDBACK_RATE_LIMITED_MESSAGE,
} from "@/lib/api/feedback";
import type { FeedbackKind } from "@/lib/api/feedback-schema";
import {
  listNotifications,
  notifyFeedbackSubmitted,
  updatePreferences,
} from "@/lib/api/notifications";
import { slackConnections } from "@/lib/db/schema";
import { feedbackAttachmentUrl } from "@/lib/linear/feedback-link";
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
    attachments: { metadata: Record<string, unknown>; url: string }[];
    createAsUser: string | null;
    title: string;
  }[]
> {
  const res = await fetch(`${linearBase()}/__test/issues`);
  return res.json();
}

async function linearRequests(): Promise<
  { complexity: number; operation: string }[]
> {
  const res = await fetch(`${linearBase()}/__test/requests`);
  return res.json();
}

async function linearControl(path: string, body: unknown) {
  const res = await fetch(`${linearBase()}/__test/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.ok).toBe(true);
}

interface SeededReport {
  archived?: boolean;
  attachmentsBefore?: { metadata: Record<string, unknown>; url: string }[];
  createdAt?: string;
  kind?: FeedbackKind;
  reporterId: string;
  stateName?: string;
  stateType?: string;
  title: string;
  trashed?: boolean;
}

// Adds an issue the way Data Hub leaves one in Linear: a report attachment
// with the metadata Data Hub reads back. Other integrations' attachments can
// come first.
async function seedReport(input: SeededReport): Promise<string> {
  const id = randomUUID();
  const kind = input.kind ?? "bug";
  const res = await fetch(`${linearBase()}/__test/issues`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id,
      title: input.title,
      createdAt: input.createdAt,
      archivedAt: input.archived ? new Date().toISOString() : null,
      trashed: input.trashed ?? false,
      state: {
        name: input.stateName ?? "Triage",
        type: input.stateType ?? "triage",
      },
      attachments: [
        ...(input.attachmentsBefore ?? []),
        {
          url: feedbackAttachmentUrl({
            origin: "https://datahub.test",
            reporterId: input.reporterId,
            kind,
            issueId: id,
          }),
          metadata: {
            version: 1,
            reporterUserId: input.reporterId,
            kind,
            title: input.title,
            description: "Seeded report.",
            source: "web",
            // Extra keys with nested values must not break reading it.
            extra: { nested: [1, { deeper: true }] },
          },
        },
      ],
    }),
  });
  expect(res.status).toBe(201);
  return id;
}

function listAs(cookie: string, query = "") {
  return api(`/api/v1/feedback${query}`, { headers: { Cookie: cookie } });
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

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
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
    expect(payload.feedback).not.toHaveProperty("admin_note");
    expect(payload.feedback).not.toHaveProperty("status_updated_by");
    expect(payload.feedback.reporter.email).toBe("ada@example.com");

    const [issue] = await linearIssues();
    expect(issue.title).toBe("Export fails");
    // The reporter's name is the issue author, not the Data Hub app.
    expect(issue.createAsUser).toBe("Ada Admin");
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

  it("returns 502 and creates nothing when Linear rejects the issue", async () => {
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
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("LINEAR_UNAVAILABLE");
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
    const { error } = await res.json();
    expect(error.code).toBe("FEEDBACK_NOT_CONFIGURED");
    expect(error.message).toBe(FEEDBACK_NOT_CONFIGURED_MESSAGE);
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

  it.each([
    ["more than 24 hours old", { createdAt: daysAgo(2) }],
    ["completed", { stateName: "Done", stateType: "completed" }],
    ["canceled", { stateName: "Canceled", stateType: "canceled" }],
    [
      "closed as a duplicate",
      { stateName: "Duplicate", stateType: "duplicate" },
    ],
  ] as const)("treats a matching report that is %s as new", async (_label, overrides) => {
    const admin = await seedTestUser({ isAdmin: true });
    const cookie = await seedSessionCookie(admin.userId);
    await enableLinear(cookie);
    await seedReport({
      reporterId: admin.userId,
      title: "Export fails",
      ...overrides,
    });

    const res = await api("/api/v1/feedback", {
      method: "POST",
      headers: { Cookie: cookie },
      body: {
        kind: "bug",
        title: "Export fails",
        description: "Stops halfway.",
      },
    });
    expect(res.status).toBe(201);
    expect((await res.json()).duplicate).toBe(false);
    expect(await linearIssues()).toHaveLength(2);
  });

  it("reads a report that has other integrations' attachments around it", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const cookie = await seedSessionCookie(admin.userId);
    await enableLinear(cookie);
    // Linear returns the first 5 attachments by default, and other
    // integrations store lists and nested objects in their metadata.
    const others = Array.from({ length: 7 }, (_, index) => ({
      url: `https://github.com/example/repo/pull/${index}`,
      metadata: {
        reviews: [{ state: "approved", reviewers: ["a", "b"] }],
        status: { merged: false, checks: [{ name: "ci", passed: true }] },
      },
    }));
    await seedReport({
      reporterId: admin.userId,
      title: "Linked to a pull request",
      attachmentsBefore: others,
    });

    const res = await listAs(cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(1);
    expect(body.feedback[0].title).toBe("Linked to a pull request");
  });

  it("returns every report on a page of up to 100, not Linear's default 50", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const cookie = await seedSessionCookie(admin.userId);
    await enableLinear(cookie);
    // 130 reports need two summary pages, and a page of 100 is above the
    // default of 50 that Linear applies when a query leaves `first` out.
    for (let index = 0; index < 130; index += 1) {
      await seedReport({
        reporterId: admin.userId,
        title: `Report ${index}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      });
    }

    const res = await listAs(cookie, "?per_page=100");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(130);
    expect(body.feedback).toHaveLength(100);
    expect(body.counts.open).toBe(130);
  });

  it("keeps old reports that Linear archived, and hides deleted ones", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const cookie = await seedSessionCookie(admin.userId);
    await enableLinear(cookie);
    await seedReport({
      reporterId: admin.userId,
      title: "Resolved long ago",
      archived: true,
      stateName: "Done",
      stateType: "completed",
    });
    await seedReport({
      reporterId: admin.userId,
      title: "Deleted in Linear",
      trashed: true,
    });

    const body = await (await listAs(cookie)).json();
    expect(body.feedback.map((item: { title: string }) => item.title)).toEqual([
      "Resolved long ago",
    ]);
    expect(body.counts).toEqual({ open: 0, resolved: 1, declined: 0 });
  });

  it("counts a report closed as a duplicate as declined", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const cookie = await seedSessionCookie(admin.userId);
    await enableLinear(cookie);
    await seedReport({
      reporterId: admin.userId,
      title: "Same as another",
      stateName: "Duplicate",
      stateType: "duplicate",
    });

    const body = await (await listAs(cookie)).json();
    expect(body.counts).toEqual({ open: 0, resolved: 0, declined: 1 });
    expect(body.feedback[0].status).toBe("declined");
    expect(body.feedback[0].linear_issue.state_name).toBe("Duplicate");
  });

  it("reads Linear once for the list and once for the details", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const cookie = await seedSessionCookie(admin.userId);
    await enableLinear(cookie);
    await seedReport({ reporterId: admin.userId, title: "One report" });
    await linearControl("reset-requests", {});

    expect((await listAs(cookie)).status).toBe(200);

    const calls = await linearRequests();
    expect(calls.map((call) => call.operation)).toEqual([
      "FeedbackIssueSummaries",
      "FeedbackIssueDetails",
    ]);
    // Linear multiplies cost by page size, so a page of 100 stays small.
    for (const call of calls) {
      expect(call.complexity).toBeLessThan(1000);
    }
  });

  it("says Linear is busy when it rate limits Data Hub", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const cookie = await seedSessionCookie(admin.userId);
    await enableLinear(cookie);
    await linearControl("rate-limit", { enabled: true });

    const res = await listAs(cookie);
    expect(res.status).toBe(502);
    const { error } = await res.json();
    expect(error.code).toBe("LINEAR_UNAVAILABLE");
    expect(error.message).toBe(FEEDBACK_RATE_LIMITED_MESSAGE);
  });

  it("tries the attachment twice, then fails and logs the issue left behind", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const cookie = await seedSessionCookie(admin.userId);
    await enableLinear(cookie);

    const res = await api("/api/v1/feedback", {
      method: "POST",
      headers: { Cookie: cookie },
      body: {
        kind: "bug",
        title: "__fail_attachment__ Export fails",
        description: "The attachment never works.",
      },
    });
    expect(res.status).toBe(502);

    const calls = await linearRequests();
    expect(
      calls.filter((call) => call.operation === "AttachmentCreate")
    ).toHaveLength(2);
    expect(await linearIssues()).toHaveLength(1);
  });

  it("finishes the issue left by a failed attachment when the report is sent again", async () => {
    const admin = await seedTestUser({ isAdmin: true });
    const cookie = await seedSessionCookie(admin.userId);
    await enableLinear(cookie);
    const body = {
      kind: "bug",
      title: "Export fails",
      description: "Stops halfway.",
    };

    await linearControl("fail-attachments", { count: 2 });
    const failed = await api("/api/v1/feedback", {
      method: "POST",
      headers: { Cookie: cookie },
      body,
    });
    expect(failed.status).toBe(502);
    expect((await linearIssues())[0].attachments).toHaveLength(0);

    const retry = await api("/api/v1/feedback", {
      method: "POST",
      headers: { Cookie: cookie },
      body,
    });
    expect(retry.status).toBe(201);
    const issues = await linearIssues();
    expect(issues).toHaveLength(1);
    expect(issues[0].attachments).toHaveLength(1);

    const listed = await (await listAs(cookie)).json();
    expect(listed.total).toBe(1);
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
