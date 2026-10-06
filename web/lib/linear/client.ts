// Linear GraphQL client for the workspace OAuth app.
//
// Tokens come from the client-credentials grant and are cached in memory
// until they expire. `__TEST_LINEAR_API_URL` points both the token and
// GraphQL calls at the fake server used by integration tests.

import { createHash } from "node:crypto";
import { z } from "zod";

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

export interface LinearTeamOptions {
  labels: LinearChoice[];
  projects: LinearChoice[];
}

// Body of `GET /api/v1/settings/integrations/linear/options`. `projects` and
// `labels` are null until a team is chosen.
export interface LinearOptionsResponse {
  labels: LinearChoice[] | null;
  projects: LinearChoice[] | null;
  teams: LinearChoice[];
}

export class LinearRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearRequestError";
  }
}

// Linear's answer when an ID in the query does not exist.
export class LinearNotFoundError extends LinearRequestError {
  constructor(message: string) {
    super(message);
    this.name = "LinearNotFoundError";
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
  }),
});

const teamsSchema = z.object({
  teams: connectionSchema,
});

const teamOptionsSchema = z.object({
  team: z.object({ projects: connectionSchema }),
  issueLabels: connectionSchema,
});

const tokenErrorSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
});

interface GraphqlErrorBody {
  extensions?: { type?: string; userPresentableMessage?: string };
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
    return new LinearRequestError(
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

  // GraphQL errors can arrive with a 4xx status, so read the body before
  // judging the status.
  const body = (await response.json().catch(() => null)) as {
    data?: unknown;
    errors?: GraphqlErrorBody[];
  } | null;
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
): Promise<{ organizationName: string }> {
  const data = await graphql(
    credentials,
    `query LinearOrganization {
      organization { id name }
    }`,
    undefined,
    organizationSchema
  );
  return { organizationName: data.organization.name };
}

export async function listLinearTeams(
  credentials: LinearCredentials
): Promise<LinearChoice[]> {
  const data = await graphql(
    credentials,
    `query LinearTeams {
      teams(first: 100) { nodes { id name } }
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
          projects(first: ${OPTIONS_PAGE_SIZE}) { nodes { id name } }
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

const issueSummaryConnectionSchema = z.object({
  issues: z.object({
    nodes: z.array(
      z.object({
        attachments: z.object({
          nodes: z.array(z.object({ url: z.string() })),
        }),
        createdAt: z.string(),
        id: z.string(),
        state: z.object({ type: z.string() }),
      })
    ),
    pageInfo: z.object({
      endCursor: z.string().nullable(),
      hasNextPage: z.boolean(),
    }),
  }),
});

const issueDetailConnectionSchema = z.object({
  issues: z.object({
    nodes: z.array(
      z.object({
        attachments: z.object({
          nodes: z.array(
            z.object({
              metadata: z.record(z.string(), z.union([z.string(), z.number()])),
              url: z.string(),
            })
          ),
        }),
        canceledAt: z.string().nullable(),
        completedAt: z.string().nullable(),
        createdAt: z.string(),
        id: z.string(),
        identifier: z.string(),
        state: z.object({ name: z.string(), type: z.string() }),
        updatedAt: z.string(),
        url: z.string(),
      })
    ),
  }),
});

export interface LinearIssueCreated {
  id: string;
  identifier: string;
  url: string;
}

export async function createLinearIssue(
  credentials: { clientId: string; clientSecret: string },
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
  credentials: { clientId: string; clientSecret: string },
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
  state: { type: string };
}

export async function listLinearIssueSummaries(
  credentials: { clientId: string; clientSecret: string },
  input: { after?: string; filter: Record<string, unknown> }
): Promise<{
  nodes: LinearIssueSummaryNode[];
  pageInfo: { endCursor: string | null; hasNextPage: boolean };
}> {
  const data = await graphql(
    credentials,
    `query FeedbackIssueSummaries($filter: IssueFilter, $after: String) {
      issues(first: 250, after: $after, filter: $filter) {
        nodes {
          id
          createdAt
          state { type }
          attachments(first: 5) { nodes { url } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    { filter: input.filter, after: input.after },
    issueSummaryConnectionSchema
  );
  return data.issues;
}

export interface LinearIssueDetailNode {
  attachments: {
    nodes: { metadata: Record<string, string | number>; url: string }[];
  };
  canceledAt: string | null;
  completedAt: string | null;
  createdAt: string;
  id: string;
  identifier: string;
  state: { name: string; type: string };
  updatedAt: string;
  url: string;
}

export async function listLinearIssueDetails(
  credentials: { clientId: string; clientSecret: string },
  ids: string[]
): Promise<LinearIssueDetailNode[]> {
  if (ids.length === 0) {
    return [];
  }
  const data = await graphql(
    credentials,
    `query FeedbackIssueDetails($ids: [ID!]!) {
      issues(filter: { id: { in: $ids } }) {
        nodes {
          id
          identifier
          url
          createdAt
          updatedAt
          completedAt
          canceledAt
          state { name type }
          attachments(first: 5) { nodes { url metadata } }
        }
      }
    }`,
    { ids },
    issueDetailConnectionSchema
  );
  return data.issues.nodes;
}
