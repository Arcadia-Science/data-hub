import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLinearTokenCache,
  LinearNotFoundError,
  LinearRequestError,
  listLinearTeamOptions,
  testLinearConnection,
} from "@/lib/linear/client";

const TEAM_ID = "11111111-1111-4111-8111-111111111111";
const credentials = { clientId: "client-1", clientSecret: "secret-1" };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const tokenOk = () =>
  json({ access_token: "token", token_type: "Bearer", expires_in: 3600 });
const organizationOk = () =>
  json({ data: { organization: { id: "org-1", name: "Test Org" } } });

describe("Linear client", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    clearLinearTokenCache();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function tokenRequests() {
    return fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/oauth/token")
    );
  }

  function routeBy(handlers: {
    graphql: () => Response;
    token: () => Response;
  }) {
    fetchMock.mockImplementation((url) =>
      Promise.resolve(
        String(url).endsWith("/oauth/token")
          ? handlers.token()
          : handlers.graphql()
      )
    );
  }

  describe("token cache", () => {
    it("reuses a token for the same client ID and secret", async () => {
      routeBy({ token: tokenOk, graphql: organizationOk });
      await testLinearConnection(credentials);
      await testLinearConnection(credentials);
      expect(tokenRequests()).toHaveLength(1);
    });

    it("asks for a new token when only the secret changes", async () => {
      routeBy({ token: tokenOk, graphql: organizationOk });
      await testLinearConnection(credentials);

      routeBy({
        token: () =>
          json(
            { error: "invalid_client", error_description: "Bad secret" },
            401
          ),
        graphql: organizationOk,
      });
      await expect(
        testLinearConnection({ ...credentials, clientSecret: "wrong" })
      ).rejects.toThrow(LinearRequestError);
      expect(tokenRequests()).toHaveLength(2);
    });

    it("asks for a new token after the cache is cleared", async () => {
      routeBy({ token: tokenOk, graphql: organizationOk });
      await testLinearConnection(credentials);
      clearLinearTokenCache();
      await testLinearConnection(credentials);
      expect(tokenRequests()).toHaveLength(2);
    });
  });

  describe("token errors", () => {
    it("tells the admin to turn on client credentials", async () => {
      routeBy({
        token: () =>
          json(
            {
              error: "Error",
              error_description:
                "Client does not support the client_credentials grant type",
            },
            400
          ),
        graphql: organizationOk,
      });
      await expect(testLinearConnection(credentials)).rejects.toThrow(
        /turn on client credentials tokens/
      );
    });

    it("includes Linear's reason when the credentials are rejected", async () => {
      routeBy({
        token: () =>
          json(
            {
              error: "invalid_client",
              error_description: "Client authentication failed",
            },
            401
          ),
        graphql: organizationOk,
      });
      await expect(testLinearConnection(credentials)).rejects.toThrow(
        "Linear rejected the app credentials (Client authentication failed). Check the client ID and client secret."
      );
    });

    it("still explains a rejection that has no JSON body", async () => {
      routeBy({
        token: () => new Response("Bad gateway", { status: 401 }),
        graphql: organizationOk,
      });
      await expect(testLinearConnection(credentials)).rejects.toThrow(
        "Linear rejected the app credentials. Check the client ID and client secret."
      );
    });
  });

  describe("listLinearTeamOptions", () => {
    const missingTeam = {
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
    };

    it("returns null when Linear does not know the team", async () => {
      routeBy({ token: tokenOk, graphql: () => json(missingTeam, 400) });
      await expect(
        listLinearTeamOptions(credentials, TEAM_ID)
      ).resolves.toBeNull();
    });

    it("throws other Linear errors", async () => {
      routeBy({
        token: tokenOk,
        graphql: () =>
          json({ errors: [{ message: "Something else broke" }] }, 200),
      });
      const error = await listLinearTeamOptions(credentials, TEAM_ID).catch(
        (err: unknown) => err
      );
      expect(error).toBeInstanceOf(LinearRequestError);
      expect(error).not.toBeInstanceOf(LinearNotFoundError);
    });

    it("asks for the team's labels plus workspace-level labels", async () => {
      routeBy({
        token: tokenOk,
        graphql: () =>
          json({
            data: {
              team: { projects: { nodes: [{ id: "p1", name: "Feedback" }] } },
              issueLabels: {
                nodes: [
                  { id: "l1", name: "Bug" },
                  { id: "l2", name: "Triage" },
                ],
              },
            },
          }),
      });

      const options = await listLinearTeamOptions(credentials, TEAM_ID);
      expect(options).toEqual({
        projects: [{ id: "p1", name: "Feedback" }],
        labels: [
          { id: "l1", name: "Bug" },
          { id: "l2", name: "Triage" },
        ],
      });

      const request = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/graphql")
      );
      const sent = JSON.parse(String(request?.[1]?.body)) as {
        query: string;
        variables: Record<string, string>;
      };
      expect(sent.variables).toEqual({
        teamId: TEAM_ID,
        labelTeamId: TEAM_ID,
      });
      expect(sent.query).toContain("issueLabels(");
      expect(sent.query).toContain("{ team: { id: { eq: $labelTeamId } } }");
      expect(sent.query).toContain("{ team: { null: true } }");
    });
  });
});
