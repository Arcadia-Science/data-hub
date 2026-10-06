import http from "node:http";

export const LINEAR_TEAM_ID = "11111111-1111-4111-8111-111111111111";
export const LINEAR_PROJECT_ID = "22222222-2222-4222-8222-222222222222";
export const LINEAR_BUG_LABEL_ID = "33333333-3333-4333-8333-333333333333";
export const LINEAR_FEATURE_LABEL_ID = "44444444-4444-4444-8444-444444444444";
export const LINEAR_OTHER_LABEL_ID = "55555555-5555-4555-8555-555555555555";

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

// Stands in for api.linear.app. Accepts any client credentials except
// client id `fail-linear`, which is rejected so tests can cover a bad secret.
export function startLinearFakeServer(): Promise<{
  close: () => Promise<void>;
  url: string;
}> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "POST" && url.pathname === "/oauth/token") {
      const params = new URLSearchParams(await readBody(req));
      if (params.get("client_id") === "fail-linear") {
        sendJson(res, 401, { error: "invalid_client" });
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

    if (req.method === "POST" && url.pathname === "/graphql") {
      if (!req.headers.authorization?.startsWith("Bearer ")) {
        sendJson(res, 401, { errors: [{ message: "Unauthorized" }] });
        return;
      }
      const raw = await readBody(req);
      const parsed = JSON.parse(raw) as { query?: unknown };
      const query = typeof parsed.query === "string" ? parsed.query : "";
      if (query.includes("organization")) {
        sendJson(res, 200, {
          data: { organization: { id: "org-1", name: "Test Org" } },
        });
        return;
      }
      if (query.includes("LinearTeamOptions")) {
        sendJson(res, 200, {
          data: {
            team: {
              projects: {
                nodes: [{ id: LINEAR_PROJECT_ID, name: "Feedback" }],
              },
              labels: {
                nodes: [
                  { id: LINEAR_BUG_LABEL_ID, name: "Bug" },
                  { id: LINEAR_FEATURE_LABEL_ID, name: "Feature" },
                  { id: LINEAR_OTHER_LABEL_ID, name: "Other" },
                ],
              },
            },
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
