// Linear GraphQL client for the workspace OAuth app.
//
// Tokens come from the client-credentials grant and are cached in memory
// until they expire. `__TEST_LINEAR_API_URL` points both the token and
// GraphQL calls at the fake server used by integration tests.

import { z } from "zod";

const TOKEN_SKEW_MS = 60_000;
const LINEAR_SCOPES = "read,issues:create";

export class LinearRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearRequestError";
  }
}

interface CachedToken {
  accessToken: string;
  clientId: string;
  expiresAt: number;
}

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
  team: z
    .object({
      labels: connectionSchema,
      projects: connectionSchema,
    })
    .nullable(),
});

export function linearApiBase(): string {
  const configured =
    process.env.__TEST_LINEAR_API_URL ?? "https://api.linear.app";
  return configured.replace(/\/$/, "");
}

export function clearLinearTokenCache(): void {
  cachedToken = null;
}

async function fetchAccessToken(credentials: {
  clientId: string;
  clientSecret: string;
}): Promise<string> {
  const now = Date.now();
  if (
    cachedToken &&
    cachedToken.clientId === credentials.clientId &&
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
    throw new LinearRequestError(
      "Linear rejected the app credentials. Check the client ID and client secret."
    );
  }

  const parsed = tokenResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new LinearRequestError(
      "Linear returned an unexpected token response."
    );
  }

  cachedToken = {
    accessToken: parsed.data.access_token,
    clientId: credentials.clientId,
    expiresAt: now + parsed.data.expires_in * 1000,
  };
  return parsed.data.access_token;
}

async function graphql<T>(
  credentials: { clientId: string; clientSecret: string },
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
  if (!response.ok) {
    throw new LinearRequestError(
      `Linear returned ${response.status}. Try again in a moment.`
    );
  }

  const body = (await response.json()) as {
    data?: unknown;
    errors?: { message?: string }[];
  };
  if (body.errors && body.errors.length > 0) {
    throw new LinearRequestError(
      body.errors[0]?.message ?? "Linear rejected the request."
    );
  }

  const parsed = schema.safeParse(body.data);
  if (!parsed.success) {
    throw new LinearRequestError("Linear returned an unexpected response.");
  }
  return parsed.data;
}

export async function testLinearConnection(credentials: {
  clientId: string;
  clientSecret: string;
}): Promise<{ organizationName: string }> {
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

export async function listLinearTeams(credentials: {
  clientId: string;
  clientSecret: string;
}): Promise<{ id: string; name: string }[]> {
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

export async function listLinearTeamOptions(
  credentials: { clientId: string; clientSecret: string },
  teamId: string
): Promise<{
  labels: { id: string; name: string }[];
  projects: { id: string; name: string }[];
} | null> {
  const data = await graphql(
    credentials,
    `query LinearTeamOptions($id: String!) {
      team(id: $id) {
        projects(first: 100) { nodes { id name } }
        labels(first: 100) { nodes { id name } }
      }
    }`,
    { id: teamId },
    teamOptionsSchema
  );
  if (!data.team) {
    return null;
  }
  return {
    projects: data.team.projects.nodes,
    labels: data.team.labels.nodes,
  };
}
