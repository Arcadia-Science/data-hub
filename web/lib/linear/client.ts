// Linear GraphQL client for the workspace OAuth app.
//
// Tokens come from the client-credentials grant and are cached in memory
// until they expire. `__TEST_LINEAR_API_URL` points both the token and
// GraphQL calls at the fake server used by integration tests.

import { createHash } from "node:crypto";
import { z } from "zod";
import { FEEDBACK_REPORT_MARKER } from "@/lib/linear/feedback-link";

const TOKEN_SKEW_MS = 60_000;
const LINEAR_SCOPES = "read,issues:create";
const OPTIONS_PAGE_SIZE = 250;

export interface LinearCredentials {
  clientId: string;
  clientSecret: string;
}

export interface LinearChoice {
  id: string;
  name: string;
}

export interface LinearTeam extends LinearChoice {
  key: string;
}

export interface LinearProject extends LinearChoice {
  url: string;
}

export interface LinearTeamOptions {
  labels: LinearChoice[];
  projects: LinearProject[];
}

// Body of `GET /api/v1/settings/integrations/linear/options`. `projects` and
// `labels` are null until a team is chosen.
export interface LinearOptionsResponse {
  labels: LinearChoice[] | null;
  projects: LinearProject[] | null;
  teams: LinearTeam[];
}

export interface LinearOrganization {
  id: string;
  name: string;
  urlKey: string;
}

export const LINEAR_RATE_LIMITED = "RATELIMITED";

export class LinearRequestError extends Error {
  // Set to `LINEAR_RATE_LIMITED` when Linear refuses the call because the app
  // used up its hourly budget, so callers can tell that apart from an outage.
  readonly code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.name = "LinearRequestError";
    this.code = code;
  }
}

// Linear's answer when an ID in the query does not exist.
export class LinearNotFoundError extends LinearRequestError {
  constructor(message: string) {
    super(message);
    this.name = "LinearNotFoundError";
  }
}

// Linear answers this way when the OAuth app exists but client credentials
// are turned off, which is a setup mistake rather than a bad secret.
export class LinearClientCredentialsError extends LinearRequestError {
  constructor(message: string) {
    super(message);
    this.name = "LinearClientCredentialsError";
  }
}

interface CachedToken {
  accessToken: string;
  credentialsKey: string;
  expiresAt: number;
}

// Module-level on purpose: each server instance reuses one token across
// requests, and Linear allows up to 1,000 such tokens per app.
let cachedToken: CachedToken | null = null;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

const namedNodeSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const connectionSchema = z.object({
  nodes: z.array(namedNodeSchema),
});

const organizationSchema = z.object({
  organization: z.object({
    id: z.string(),
    name: z.string(),
    urlKey: z.string(),
  }),
});

const teamNodeSchema = namedNodeSchema.extend({
  key: z.string(),
});

const projectNodeSchema = namedNodeSchema.extend({
  url: z.string(),
});

const teamsSchema = z.object({
  teams: z.object({ nodes: z.array(teamNodeSchema) }),
});

const teamOptionsSchema = z.object({
  team: z.object({
    projects: z.object({ nodes: z.array(projectNodeSchema) }),
  }),
  issueLabels: connectionSchema,
});

const tokenErrorSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

interface GraphqlErrorBody {
  extensions?: {
    code?: string;
    type?: string;
    userPresentableMessage?: string;
  };
  message?: string;
}

export function linearApiBase(): string {
  const configured =
    process.env.__TEST_LINEAR_API_URL ?? "https://api.linear.app";
  return configured.replace(/\/$/, "");
}

export function clearLinearTokenCache(): void {
  cachedToken = null;
}

// The secret is part of the key so a wrong secret never reuses a token that
// was issued for the right one. Only a hash of it is kept.
function credentialsKey({ clientId, clientSecret }: LinearCredentials): string {
  const secretHash = createHash("sha256").update(clientSecret).digest("hex");
  return `${clientId}:${secretHash}`;
}

async function tokenFailure(response: Response): Promise<LinearRequestError> {
  const parsed = tokenErrorSchema.safeParse(
    await response.json().catch(() => null)
  );
  const { error, error_description: description } = parsed.success
    ? parsed.data
    : {};

  // Linear answers `{"error":"Error","error_description":"Client does not
  // support the client_credentials grant type"}` when the app has client
  // credentials turned off.
  if (
    error === "unsupported_grant_type" ||
    /does not support the client_credentials grant type/i.test(
      description ?? ""
    )
  ) {
    return new LinearClientCredentialsError(
      "Client credentials are turned off for this Linear app. In the app's settings in Linear, turn on client credentials tokens."
    );
  }
  if (response.status >= 500) {
    return new LinearRequestError(
      `Linear returned ${response.status}. Try again in a moment.`
    );
  }
  const reason = description ?? error;
  return new LinearRequestError(
    `Linear rejected the app credentials${reason ? ` (${reason})` : ""}. Check the client ID and client secret.`
  );
}

async function fetchAccessToken(
  credentials: LinearCredentials
): Promise<string> {
  const now = Date.now();
  const key = credentialsKey(credentials);
  if (
    cachedToken &&
    cachedToken.credentialsKey === key &&
    cachedToken.expiresAt > now + TOKEN_SKEW_MS
  ) {
    return cachedToken.accessToken;
  }

  const response = await fetch(`${linearApiBase()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: LINEAR_SCOPES,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  });
  if (!response.ok) {
    throw await tokenFailure(response);
  }

  const parsed = tokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new LinearRequestError(
      "Linear returned an unexpected token response."
    );
  }

  cachedToken = {
    accessToken: parsed.data.access_token,
    credentialsKey: key,
    expiresAt: now + parsed.data.expires_in * 1000,
  };
  return parsed.data.access_token;
}

// Linear reports an ID that does not exist as an "invalid input" error that
// names the missing entity. Its SDK's end-to-end test for `team(id:)` with an
// unknown ID expects "Entity not found - Could not find referenced Team".
function isMissingEntity(error: GraphqlErrorBody): boolean {
  if (error.extensions?.type !== "invalid input") {
    return false;
  }
  const text = `${error.message ?? ""} ${error.extensions.userPresentableMessage ?? ""}`;
  return /Entity not found|Could not find referenced/i.test(text);
}

function graphqlFailure(error: GraphqlErrorBody): LinearRequestError {
  const message =
    error.message ??
    error.extensions?.userPresentableMessage ??
    "Linear rejected the request.";
  return isMissingEntity(error)
    ? new LinearNotFoundError(message)
    : new LinearRequestError(message);
}

async function graphql<T>(
  credentials: LinearCredentials,
  query: string,
  variables: Record<string, unknown> | undefined,
  schema: z.ZodType<T>
): Promise<T> {
  const run = async (forceRefresh: boolean) => {
    if (forceRefresh) {
      clearLinearTokenCache();
    }
    const accessToken = await fetchAccessToken(credentials);
    return fetch(`${linearApiBase()}/graphql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
    });
  };

  let response = await run(false);
  if (response.status === 401) {
    response = await run(true);
  }

  // GraphQL errors can arrive with a 4xx status (a rate-limited call is a
  // 400), so read the body before judging the status.
  const body = (await response.json().catch(() => null)) as {
    data?: unknown;
    errors?: GraphqlErrorBody[];
  } | null;
  if (
    body?.errors?.some(
      (error) => error.extensions?.code === LINEAR_RATE_LIMITED
    )
  ) {
    throw new LinearRequestError(
      "Linear is limiting how often Data Hub can call it. Try again in a few minutes.",
      LINEAR_RATE_LIMITED
    );
  }
  if (body?.errors && body.errors.length > 0) {
    throw graphqlFailure(body.errors[0] ?? {});
  }
  if (!response.ok) {
    throw new LinearRequestError(
      `Linear returned ${response.status}. Try again in a moment.`
    );
  }

  const parsed = schema.safeParse(body?.data);
  if (!parsed.success) {
    throw new LinearRequestError("Linear returned an unexpected response.");
  }
  return parsed.data;
}

export async function testLinearConnection(
  credentials: LinearCredentials
): Promise<LinearOrganization> {
  const data = await graphql(
    credentials,
    `query LinearOrganization {
      organization { id name urlKey }
    }`,
    undefined,
    organizationSchema
  );
  return data.organization;
}

export async function listLinearTeams(
  credentials: LinearCredentials
): Promise<LinearTeam[]> {
  const data = await graphql(
    credentials,
    `query LinearTeams {
      teams(first: 100) { nodes { id name key } }
    }`,
    undefined,
    teamsSchema
  );
  return data.teams.nodes;
}

// Labels come from `issueLabels` rather than `team.labels` because the team's
// own list leaves out workspace-level labels, which any team can use. Returns
// null when Linear does not know the team.
export async function listLinearTeamOptions(
  credentials: LinearCredentials,
  teamId: string
): Promise<LinearTeamOptions | null> {
  try {
    const data = await graphql(
      credentials,
      `query LinearTeamOptions($teamId: String!, $labelTeamId: ID!) {
        team(id: $teamId) {
          projects(first: ${OPTIONS_PAGE_SIZE}) { nodes { id name url } }
        }
        issueLabels(
          first: ${OPTIONS_PAGE_SIZE}
          filter: { or: [{ team: { id: { eq: $labelTeamId } } }, { team: { null: true } }] }
        ) { nodes { id name } }
      }`,
      { teamId, labelTeamId: teamId },
      teamOptionsSchema
    );
    return {
      projects: data.team.projects.nodes,
      labels: data.issueLabels.nodes,
    };
  } catch (err) {
    if (err instanceof LinearNotFoundError) {
      return null;
    }
    throw err;
  }
}

const issueCreatedSchema = z.object({
  issueCreate: z.object({
    issue: z
      .object({
        id: z.string(),
        identifier: z.string(),
        url: z.string(),
      })
      .nullable(),
    success: z.boolean(),
  }),
});

const attachmentCreatedSchema = z.object({
  attachmentCreate: z.object({
    attachment: z.object({ id: z.string() }).nullable(),
    success: z.boolean(),
  }),
});

const issueStateSchema = z.object({
  color: z.string(),
  id: z.string(),
  name: z.string(),
  type: z.string(),
});

const issueSummaryConnectionSchema = z.object({
  issues: z.object({
    nodes: z.array(
      z.object({
        attachments: z.object({
          nodes: z.array(z.object({ url: z.string() })),
        }),
        createdAt: z.string(),
        id: z.string(),
        state: issueStateSchema.extend({ position: z.number() }),
        trashed: z.boolean().nullable(),
      })
    ),
    pageInfo: z.object({
      endCursor: z.string().nullable(),
      hasNextPage: z.boolean(),
    }),
  }),
});

// Other integrations store lists and nested objects in attachment metadata,
// so only the Data Hub attachment's metadata is checked, by its caller.
const linearUserSchema = z.object({
  avatarUrl: z.string().nullable(),
  email: z.string().nullable(),
  id: z.string(),
  name: z.string(),
});

const issueDetailNodeSchema = z.object({
  assignee: linearUserSchema.nullable(),
  attachments: z.object({
    nodes: z.array(
      z.object({
        metadata: z.record(z.string(), z.unknown()),
        url: z.string(),
      })
    ),
  }),
  canceledAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  id: z.string(),
  identifier: z.string(),
  labels: z.object({
    nodes: z.array(z.object({ color: z.string(), name: z.string() })),
  }),
  priority: z.number(),
  priorityLabel: z.string(),
  project: z.object({ name: z.string() }).nullable(),
  state: issueStateSchema,
  team: z.object({ key: z.string(), name: z.string() }),
  trashed: z.boolean().nullable(),
  updatedAt: z.string(),
  url: z.string(),
});

const issueDetailConnectionSchema = z.object({
  issues: z.object({
    nodes: z.array(issueDetailNodeSchema),
  }),
});

const issueDetailSchema = z.object({
  issue: issueDetailNodeSchema.nullable(),
});

export interface LinearIssueCreated {
  id: string;
  identifier: string;
  url: string;
}

export async function createLinearIssue(
  credentials: LinearCredentials,
  input: {
    createAsUser: string;
    description: string;
    labelIds: string[];
    projectId: string | null;
    teamId: string;
    title: string;
  }
): Promise<LinearIssueCreated> {
  const data = await graphql(
    credentials,
    `mutation IssueCreate($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url }
      }
    }`,
    {
      input: {
        title: input.title,
        description: input.description,
        teamId: input.teamId,
        projectId: input.projectId,
        labelIds: input.labelIds,
        createAsUser: input.createAsUser,
      },
    },
    issueCreatedSchema
  );
  if (!(data.issueCreate.success && data.issueCreate.issue)) {
    throw new LinearRequestError("Linear did not create the issue.");
  }
  return data.issueCreate.issue;
}

export async function createLinearAttachment(
  credentials: LinearCredentials,
  input: {
    issueId: string;
    metadata: Record<string, string | number>;
    title: string;
    url: string;
  }
): Promise<void> {
  const data = await graphql(
    credentials,
    `mutation AttachmentCreate($input: AttachmentCreateInput!) {
      attachmentCreate(input: $input) {
        success
        attachment { id }
      }
    }`,
    { input },
    attachmentCreatedSchema
  );
  if (!data.attachmentCreate.success) {
    throw new LinearRequestError("Linear did not attach the report.");
  }
}

export interface LinearIssueSummaryNode {
  attachments: { nodes: { url: string }[] };
  createdAt: string;
  id: string;
  state: {
    color: string;
    id: string;
    name: string;
    position: number;
    type: string;
  };
}

// Linear bills a query by page size even when fewer issues match, so the page
// stays small and each issue returns only its Data Hub attachment. That keeps
// one call to a few hundred points, against 2,000,000 per hour.
export const LINEAR_SUMMARY_PAGE_SIZE = 100;

// `includeArchived` keeps old reports visible, because Linear archives closed
// issues on its own after the team's auto-archive period. Deleted issues come
// back with `trashed` set and are dropped here.
export async function listLinearIssueSummaries(
  credentials: LinearCredentials,
  input: {
    after?: string;
    filter: Record<string, unknown>;
    pageSize?: number;
  }
): Promise<{
  nodes: LinearIssueSummaryNode[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
}> {
  const data = await graphql(
    credentials,
    `query FeedbackIssueSummaries($filter: IssueFilter, $after: String, $first: Int, $marker: String!) {
      issues(first: $first, after: $after, includeArchived: true, filter: $filter) {
        nodes {
          id
          createdAt
          trashed
          state { id name type color position }
          attachments(first: 1, filter: { url: { contains: $marker } }) { nodes { url } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    {
      filter: input.filter,
      after: input.after,
      first: input.pageSize ?? LINEAR_SUMMARY_PAGE_SIZE,
      marker: FEEDBACK_REPORT_MARKER,
    },
    issueSummaryConnectionSchema
  );
  return {
    nodes: data.issues.nodes.filter((node) => !node.trashed),
    pageInfo: data.issues.pageInfo,
  };
}

export interface LinearIssueUser {
  avatarUrl: string | null;
  email: string | null;
  id: string;
  name: string;
}

export interface LinearIssueLabel {
  color: string;
  name: string;
}

export interface LinearIssueDetailNode {
  assignee: LinearIssueUser | null;
  attachments: {
    nodes: { metadata: Record<string, unknown>; url: string }[];
  };
  canceledAt: string | null;
  completedAt: string | null;
  createdAt: string;
  id: string;
  identifier: string;
  labels: { nodes: LinearIssueLabel[] };
  priority: number;
  priorityLabel: string;
  project: { name: string } | null;
  state: { color: string; id: string; name: string; type: string };
  team: { key: string; name: string };
  updatedAt: string;
  url: string;
}

// Shared by the page of details and the single-issue lookup. `issue(id:)`
// accepts either the UUID or the team's issue ID, such as ENG-1476.
const ISSUE_DETAIL_FIELDS = `
  id
  identifier
  url
  createdAt
  updatedAt
  completedAt
  canceledAt
  trashed
  priority
  priorityLabel
  state { id name type color }
  labels(first: 10) { nodes { name color } }
  assignee { id name email avatarUrl }
  project { name }
  team { name key }
  attachments(first: 1, filter: { url: { contains: $marker } }) { nodes { url metadata } }
`;

// `first` matches the number of ids. Without it Linear returns 50 issues.
export async function listLinearIssueDetails(
  credentials: LinearCredentials,
  ids: string[]
): Promise<LinearIssueDetailNode[]> {
  if (ids.length === 0) {
    return [];
  }
  const data = await graphql(
    credentials,
    `query FeedbackIssueDetails($filter: IssueFilter, $first: Int, $marker: String!) {
      issues(first: $first, includeArchived: true, filter: $filter) {
        nodes {${ISSUE_DETAIL_FIELDS}
        }
      }
    }`,
    {
      filter: { id: { in: ids } },
      first: ids.length,
      marker: FEEDBACK_REPORT_MARKER,
    },
    issueDetailConnectionSchema
  );
  return data.issues.nodes.filter((node) => !node.trashed);
}

// One issue, by its UUID or its Linear ID (`ENG-1476`). Missing and deleted
// issues come back as null.
export async function getLinearIssueDetail(
  credentials: LinearCredentials,
  id: string
): Promise<LinearIssueDetailNode | null> {
  try {
    const data = await graphql(
      credentials,
      `query FeedbackIssue($id: String!, $marker: String!) {
        issue(id: $id) {${ISSUE_DETAIL_FIELDS}
        }
      }`,
      { id, marker: FEEDBACK_REPORT_MARKER },
      issueDetailSchema
    );
    if (!data.issue || data.issue.trashed) {
      return null;
    }
    return data.issue;
  } catch (err) {
    if (err instanceof LinearNotFoundError) {
      return null;
    }
    throw err;
  }
}

const issueActivitySchema = z.object({
  issue: z
    .object({
      comments: z.object({
        nodes: z.array(
          z.object({
            body: z.string(),
            createdAt: z.string(),
            user: z
              .object({
                email: z.string().nullable(),
                name: z.string(),
              })
              .nullable(),
          })
        ),
      }),
      history: z.object({
        nodes: z.array(
          z.object({
            actor: z.object({ name: z.string() }).nullable(),
            botActor: z.object({ name: z.string().nullable() }).nullable(),
            createdAt: z.string(),
            fromState: z.object({ name: z.string() }).nullable(),
            toState: z.object({ name: z.string() }).nullable(),
          })
        ),
      }),
    })
    .nullable(),
});

export interface LinearStatusChange {
  actorName: string | null;
  at: string;
  fromState: string | null;
  toState: string | null;
}

export interface LinearComment {
  at: string;
  body: string;
  userEmail: string | null;
  userName: string | null;
}

// Status moves and comments for one issue. History rows that did not change
// the status are dropped here, so the caller can show them in time order.
export async function getLinearIssueActivity(
  credentials: LinearCredentials,
  id: string
): Promise<{
  comments: LinearComment[];
  statusChanges: LinearStatusChange[];
} | null> {
  try {
    const data = await graphql(
      credentials,
      `query FeedbackIssueActivity($id: String!) {
        issue(id: $id) {
          history(first: 50) {
            nodes {
              createdAt
              fromState { name }
              toState { name }
              actor { name }
              botActor { name }
            }
          }
          comments(first: 50) {
            nodes {
              body
              createdAt
              user { name email }
            }
          }
        }
      }`,
      { id },
      issueActivitySchema
    );
    if (!data.issue) {
      return null;
    }
    return {
      statusChanges: data.issue.history.nodes.flatMap((entry) => {
        if (!(entry.fromState || entry.toState)) {
          return [];
        }
        return [
          {
            at: entry.createdAt,
            fromState: entry.fromState?.name ?? null,
            toState: entry.toState?.name ?? null,
            actorName: entry.actor?.name ?? entry.botActor?.name ?? null,
          },
        ];
      }),
      comments: data.issue.comments.nodes.map((comment) => ({
        at: comment.createdAt,
        body: comment.body,
        userName: comment.user?.name ?? null,
        userEmail: comment.user?.email ?? null,
      })),
    };
  } catch (err) {
    if (err instanceof LinearNotFoundError) {
      return null;
    }
    throw err;
  }
}

const workflowStateSchema = z.object({
  workflowStates: z.object({
    nodes: z.array(z.object({ type: z.string() })),
  }),
});

// Looks the state up in a list, not by `workflowState(id:)`, so a state that
// an admin deleted comes back as null and not as an error. `includeArchived`
// keeps those deleted states findable.
export async function getLinearWorkflowStateType(
  credentials: LinearCredentials,
  stateId: string
): Promise<string | null> {
  const data = await graphql(
    credentials,
    `query FeedbackWorkflowState($filter: WorkflowStateFilter, $first: Int) {
      workflowStates(first: $first, includeArchived: true, filter: $filter) {
        nodes { type }
      }
    }`,
    { filter: { id: { eq: stateId } }, first: 1 },
    workflowStateSchema
  );
  return data.workflowStates.nodes[0]?.type ?? null;
}
