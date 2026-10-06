import { randomUUID } from "node:crypto";
import http from "node:http";

export const LINEAR_TEAM_ID = "11111111-1111-4111-8111-111111111111";
export const LINEAR_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
export const LINEAR_BUG_LABEL_ID = "33333333-3333-4333-8333-333333333333";
export const LINEAR_FEATURE_LABEL_ID = "44444444-4444-4444-8444-444444444444";
export const LINEAR_OTHER_LABEL_ID = "55555555-5555-4555-8555-555555555555";
// Not tied to any team, so every team's label list includes it.
export const LINEAR_WORKSPACE_LABEL_ID = "66666666-6666-4666-8666-666666666666";
// Belongs to another team, so the fake never returns it for LINEAR_TEAM_ID.
export const LINEAR_OTHER_TEAM_LABEL_ID =
  "77777777-7777-4777-8777-777777777777";

// Client ID and secret that Linear rejects, and a client ID whose app has
// client credentials turned off. Tests send these to cover each failure.
export const LINEAR_BAD_CLIENT_ID = "fail-linear";
export const LINEAR_BAD_CLIENT_SECRET = "wrong-linear-secret";
export const LINEAR_NO_CLIENT_CREDENTIALS_CLIENT_ID = "no-client-credentials";

const LABELS = [
  { id: LINEAR_BUG_LABEL_ID, name: "Bug", teamId: LINEAR_TEAM_ID },
  { id: LINEAR_FEATURE_LABEL_ID, name: "Feature", teamId: LINEAR_TEAM_ID },
  { id: LINEAR_OTHER_LABEL_ID, name: "Other", teamId: LINEAR_TEAM_ID },
  { id: LINEAR_WORKSPACE_LABEL_ID, name: "Triage", teamId: null },
  {
    id: LINEAR_OTHER_TEAM_LABEL_ID,
    name: "Elsewhere",
    teamId: "88888888-8888-4888-8888-888888888888",
  },
];

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

interface FakeAttachment {
  metadata: Record<string, string | number>;
  url: string;
}

interface FakeIssue {
  attachments: FakeAttachment[];
  canceledAt: string | null;
  completedAt: string | null;
  createdAt: string;
  description: string;
  id: string;
  identifier: string;
  state: { name: string; type: string };
  title: string;
  updatedAt: string;
  url: string;
}

const issues: FakeIssue[] = [];
let issueSeq = 1;

function matchesFilter(
  issue: FakeIssue,
  filter: Record<string, unknown> | undefined
) {
  if (!filter) {
    return true;
  }
  const idFilter = filter.id as { in?: string[] } | undefined;
  if (idFilter?.in && !idFilter.in.includes(issue.id)) {
    return false;
  }
  const title = filter.title as { eq?: string } | undefined;
  if (title?.eq && issue.title !== title.eq) {
    return false;
  }
  const createdAt = filter.createdAt as { gte?: string } | undefined;
  if (createdAt?.gte && issue.createdAt < createdAt.gte) {
    return false;
  }
  const attachments = filter.attachments as
    | { some?: { url?: { contains?: string } } }
    | undefined;
  const contains = attachments?.some?.url?.contains;
  if (
    contains &&
    !issue.attachments.some((attachment) => attachment.url.includes(contains))
  ) {
    return false;
  }
  const state = filter.state as { type?: { nin?: string[] } } | undefined;
  if (state?.type?.nin?.includes(issue.state.type)) {
    return false;
  }
  return true;
}

function issueConnection(
  matched: FakeIssue[],
  variables: { after?: string; first?: number }
) {
  const first = variables.first ?? 50;
  const after = Number(variables.after ?? 0);
  const slice = matched.slice(after, after + first);
  return {
    nodes: slice.map((issue) => ({
      ...issue,
      attachments: { nodes: issue.attachments },
    })),
    pageInfo: {
      hasNextPage: after + first < matched.length,
      endCursor: String(after + first),
    },
  };
}

// Stands in for api.linear.app. Accepts any client credentials except the
// `LINEAR_BAD_*` and `LINEAR_NO_CLIENT_CREDENTIALS_*` values above.
export function startLinearFakeServer(): Promise<{
  close: () => Promise<void>;
  url: string;
}> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/oauth/token") {
      const params = new URLSearchParams(await readBody(req));
      // The body Linear documents for an app without client credentials.
      if (params.get("client_id") === LINEAR_NO_CLIENT_CREDENTIALS_CLIENT_ID) {
        sendJson(res, 400, {
          error: "Error",
          error_description:
            "Client does not support the client_credentials grant type",
        });
        return;
      }
      // Linear does not document this body; it follows RFC 6749.
      if (
        params.get("client_id") === LINEAR_BAD_CLIENT_ID ||
        params.get("client_secret") === LINEAR_BAD_CLIENT_SECRET
      ) {
        sendJson(res, 401, {
          error: "invalid_client",
          error_description: "Client authentication failed",
        });
        return;
      }
      sendJson(res, 200, {
        access_token: "test-linear-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "read,issues:create",
      });
      return;
    }

    if (url.pathname === "/__test/reset" && req.method === "POST") {
      issues.length = 0;
      issueSeq = 1;
      sendJson(res, 200, { ok: true });
      return;
    }
    if (url.pathname === "/__test/issues" && req.method === "GET") {
      sendJson(res, 200, issues);
      return;
    }
    if (url.pathname === "/__test/issues" && req.method === "POST") {
      const body = JSON.parse(await readBody(req)) as Partial<FakeIssue>;
      const id = body.id ?? randomUUID();
      issues.push({
        id,
        identifier: body.identifier ?? `DH-${issueSeq++}`,
        title: body.title ?? "Bare issue",
        description: body.description ?? "",
        url: body.url ?? `https://linear.app/test/issue/${id}`,
        createdAt: body.createdAt ?? new Date().toISOString(),
        updatedAt: body.updatedAt ?? new Date().toISOString(),
        completedAt: body.completedAt ?? null,
        canceledAt: body.canceledAt ?? null,
        state: body.state ?? { name: "Triage", type: "triage" },
        attachments: body.attachments ?? [],
      });
      sendJson(res, 201, { id });
      return;
    }

    if (req.method === "POST" && url.pathname === "/graphql") {
      if (!req.headers.authorization?.startsWith("Bearer ")) {
        sendJson(res, 401, { errors: [{ message: "Unauthorized" }] });
        return;
      }
      const raw = await readBody(req);
      const parsed = JSON.parse(raw) as {
        query?: unknown;
        variables?: Record<string, unknown>;
      };
      const query = typeof parsed.query === "string" ? parsed.query : "";
      if (query.includes("organization")) {
        sendJson(res, 200, {
          data: { organization: { id: "org-1", name: "Test Org" } },
        });
        return;
      }
      if (query.includes("LinearTeamOptions")) {
        const variables = (parsed.variables ?? {}) as {
          labelTeamId?: string;
          teamId?: string;
        };
        // Linear answers an unknown team ID with an "invalid input" error
        // and a 4xx status, not a null team.
        if (variables.teamId !== LINEAR_TEAM_ID) {
          sendJson(res, 400, {
            errors: [
              {
                message: "Entity not found",
                path: ["team"],
                extensions: {
                  type: "invalid input",
                  userError: true,
                  userPresentableMessage: "Could not find referenced Team.",
                },
              },
            ],
            data: null,
          });
          return;
        }
        // Mirrors the query's filter: the team's labels plus workspace labels.
        const nodes = LABELS.filter(
          (label) =>
            label.teamId === null || label.teamId === variables.labelTeamId
        ).map(({ id, name }) => ({ id, name }));
        sendJson(res, 200, {
          data: {
            team: {
              projects: {
                nodes: [{ id: LINEAR_PROJECT_ID, name: "Feedback" }],
              },
            },
            issueLabels: { nodes },
          },
        });
        return;
      }
      if (query.includes("LinearTeams")) {
        sendJson(res, 200, {
          data: {
            teams: { nodes: [{ id: LINEAR_TEAM_ID, name: "Data Hub" }] },
          },
        });
        return;
      }
      const variables = (parsed.variables ?? {}) as {
        after?: string;
        filter?: Record<string, unknown>;
        first?: number;
        ids?: string[];
        input?: {
          createAsUser?: string;
          description?: string;
          issueId?: string;
          metadata?: Record<string, string | number>;
          title?: string;
          url?: string;
        };
      };
      if (query.includes("IssueCreate")) {
        const title = variables.input?.title ?? "";
        if (title === "__fail_linear__") {
          sendJson(res, 200, {
            errors: [{ message: "Linear is down" }],
          });
          return;
        }
        const id = randomUUID();
        const identifier = `DH-${issueSeq++}`;
        const now = new Date().toISOString();
        issues.push({
          id,
          identifier,
          title,
          description: variables.input?.description ?? "",
          url: `https://linear.app/test/issue/${identifier}`,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
          canceledAt: null,
          state: { name: "Triage", type: "triage" },
          attachments: [],
        });
        sendJson(res, 200, {
          data: {
            issueCreate: {
              success: true,
              issue: {
                id,
                identifier,
                url: `https://linear.app/test/issue/${identifier}`,
              },
            },
          },
        });
        return;
      }
      if (query.includes("AttachmentCreate")) {
        const issue = issues.find(
          (item) => item.id === variables.input?.issueId
        );
        if (!issue || issue.title.startsWith("__fail_attachment__")) {
          sendJson(res, 200, {
            errors: [{ message: "Could not attach" }],
          });
          return;
        }
        issue.attachments.push({
          url: variables.input?.url ?? "",
          metadata: variables.input?.metadata ?? {},
        });
        sendJson(res, 200, {
          data: {
            attachmentCreate: {
              success: true,
              attachment: { id: randomUUID() },
            },
          },
        });
        return;
      }
      if (query.includes("FeedbackIssueDetails")) {
        const ids = variables.ids ?? [];
        const matched = issues.filter((issue) => ids.includes(issue.id));
        sendJson(res, 200, {
          data: { issues: issueConnection(matched, { first: ids.length }) },
        });
        return;
      }
      if (query.includes("FeedbackIssueSummaries")) {
        const matched = issues.filter((issue) =>
          matchesFilter(issue, variables.filter)
        );
        sendJson(res, 200, {
          data: {
            issues: issueConnection(matched, variables),
          },
        });
        return;
      }
      sendJson(res, 400, { errors: [{ message: "Unknown query" }] });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to start the Linear fake server"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
    server.on("error", reject);
  });
}
