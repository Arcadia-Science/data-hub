import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";

function jsonRpc(method: string, params: unknown = {}, id = 1) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method,
    params,
  };
}

const MCP_HEADERS = {
  Accept: "application/json, text/event-stream",
};

async function parseSseResponse(res: Response) {
  const text = await res.text();
  const events = text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data: "));
      if (!dataLine) {
        return null;
      }
      return JSON.parse(dataLine.slice("data: ".length));
    })
    .filter(Boolean);
  return events.at(-1);
}

describe("MCP Server (HTTP)", () => {
  let token: string;
  let userId: string;
  let tokenB: string;

  const instrumentId = "mcp-test-instrument";
  const runId = "mcp-test-run";

  beforeAll(async () => {
    await resetDb();
    ({ token, userId } = await seedTestUser());
    ({ token: tokenB } = await seedTestUser());

    const db = getTestDb();
    await db.insert(schema.instruments).values({
      id: instrumentId,
      displayName: "MCP Test Instrument",
      status: "active",
      instrumentType: "plate_reader",
    });

    await db.insert(schema.instrumentRuns).values({
      instrumentId,
      runId,
      source: "lambda",
    });
  });

  // Wipe attributions between tool-call tests so each one controls the state
  // it asserts against. The seeded run cascades from `instrument_runs` and
  // survives the delete.
  beforeEach(async () => {
    const db = getTestDb();
    await db.delete(schema.runAttributions);
  });

  afterAll(async () => {
    await closeTestDb();
  });

  // Helper — POST a tools/call request and return the parsed JSON-RPC result.
  async function callTool(
    name: string,
    args: Record<string, unknown>,
    bearer: string = token
  ): Promise<{
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  }> {
    const res = await api("/api/v1/mcp", {
      method: "POST",
      token: bearer,
      headers: MCP_HEADERS,
      body: jsonRpc("tools/call", { name, arguments: args }),
    });
    expect(res.status).toBe(200);
    const data = await parseSseResponse(res);
    return data.result;
  }

  // ---- Auth ----------------------------------------------------------------

  it("rejects unauthenticated requests with 401", async () => {
    const res = await api("/api/v1/mcp", {
      method: "POST",
      headers: MCP_HEADERS,
      body: jsonRpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      }),
    });
    expect(res.status).toBe(401);
  });

  // ---- Initialize ----------------------------------------------------------

  it("initializes with valid token", async () => {
    const res = await api("/api/v1/mcp", {
      method: "POST",
      token,
      headers: MCP_HEADERS,
      body: jsonRpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      }),
    });
    expect(res.status).toBe(200);
    const data = await parseSseResponse(res);
    expect(data.result).toBeDefined();
    expect(data.result.protocolVersion).toBeTruthy();
    expect(data.result.capabilities).toBeDefined();
  });

  // ---- tools/list ----------------------------------------------------------

  it("lists all registered tools", async () => {
    const res = await api("/api/v1/mcp", {
      method: "POST",
      token,
      headers: MCP_HEADERS,
      body: jsonRpc("tools/list"),
    });
    expect(res.status).toBe(200);
    const data = await parseSseResponse(res);
    const toolNames: string[] = data.result.tools.map(
      (t: { name: string }) => t.name
    );
    expect(toolNames).toContain("list_instruments");
    expect(toolNames).toContain("get_instrument");
    expect(toolNames).toContain("search_runs");
    expect(toolNames).toContain("get_run");
    expect(toolNames).toContain("list_run_files");
    expect(toolNames).toContain("get_file");
    expect(toolNames).toContain("get_file_download_url");
    expect(toolNames).toContain("get_run_archive");
    expect(toolNames).toContain("get_system_status");
    expect(toolNames).toContain("list_watchers");
    expect(toolNames).toContain("get_watcher_heartbeats");
    expect(toolNames).toContain("reprocess_file");
    expect(toolNames).toContain("claim_run");
    expect(toolNames).toContain("unclaim_run");
    expect(toolNames).toContain("list_run_attributors");
    expect(toolNames).toHaveLength(15);
  });

  // ---- Tool execution (end-to-end) -----------------------------------------

  it("executes list_instruments tool against real DB", async () => {
    const res = await api("/api/v1/mcp", {
      method: "POST",
      token,
      headers: MCP_HEADERS,
      body: jsonRpc("tools/call", {
        name: "list_instruments",
        arguments: {},
      }),
    });
    expect(res.status).toBe(200);
    const data = await parseSseResponse(res);
    expect(data.result.isError).toBeFalsy();
    const text = data.result.content[0].text;
    const instruments = JSON.parse(text);
    expect(instruments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: instrumentId })])
    );
  });

  // ---- Attribution tools (end-to-end) --------------------------------------

  // These tests exercise the auth wiring: `authInfo.extra.userId` is the only
  // user id ever written, regardless of what the client sneaks into
  // arguments. They also cover idempotency and the `ranBy` filter that
  // `search_runs` now accepts.

  it("claim_run attributes the run to the token's user and is idempotent", async () => {
    const first = await callTool("claim_run", {
      instrumentId,
      runId,
    });
    expect(first.isError).toBeFalsy();
    const firstParsed = JSON.parse(first.content[0].text);
    expect(firstParsed.attributions).toHaveLength(1);
    expect(firstParsed.attributions[0].userId).toBe(userId);

    const second = await callTool("claim_run", { instrumentId, runId });
    expect(second.isError).toBeFalsy();
    const secondParsed = JSON.parse(second.content[0].text);
    expect(secondParsed.attributions).toHaveLength(1);
    expect(secondParsed.attributions[0].userId).toBe(userId);
  });

  it("claim_run ignores a spoofed userId argument — the token's user is the attributor", async () => {
    const result = await callTool("claim_run", {
      instrumentId,
      runId,
      userId: "some-other-user",
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.attributions).toHaveLength(1);
    expect(parsed.attributions[0].userId).toBe(userId);
    expect(parsed.attributions[0].userId).not.toBe("some-other-user");
  });

  it("claim_run on a nonexistent run returns an error", async () => {
    const result = await callTool("claim_run", {
      instrumentId,
      runId: "nonexistent-run",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text.toLowerCase()).toContain("not found");
  });

  it("unclaim_run removes attribution and is idempotent", async () => {
    await callTool("claim_run", { instrumentId, runId });

    const first = await callTool("unclaim_run", { instrumentId, runId });
    expect(first.isError).toBeFalsy();
    const firstParsed = JSON.parse(first.content[0].text);
    expect(firstParsed.attributions).toEqual([]);

    const second = await callTool("unclaim_run", { instrumentId, runId });
    expect(second.isError).toBeFalsy();
    const secondParsed = JSON.parse(second.content[0].text);
    expect(secondParsed.attributions).toEqual([]);
  });

  it("search_runs ranBy=<userId> filters runs to that user's attributions", async () => {
    // User A claims the seeded run, then user B searches by user A's id.
    await callTool("claim_run", { instrumentId, runId });

    const ranByA = await callTool(
      "search_runs",
      { instrumentId, ranBy: userId },
      tokenB
    );
    expect(ranByA.isError).toBeFalsy();
    const ranByAParsed = JSON.parse(ranByA.content[0].text);
    const ranByARunIds = ranByAParsed.data.map(
      (r: { run_id: string }) => r.run_id
    );
    expect(ranByARunIds).toContain(runId);

    const unattributed = await callTool(
      "search_runs",
      { instrumentId, ranBy: "unattributed" },
      tokenB
    );
    expect(unattributed.isError).toBeFalsy();
    const unattributedParsed = JSON.parse(unattributed.content[0].text);
    const unattributedRunIds = unattributedParsed.data.map(
      (r: { run_id: string }) => r.run_id
    );
    expect(unattributedRunIds).not.toContain(runId);
  });

  it("list_run_attributors returns the set of attributors for an instrument", async () => {
    await callTool("claim_run", { instrumentId, runId });

    const result = await callTool("list_run_attributors", { instrumentId });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text) as Array<{
      userId: string;
      displayName: string;
    }>;
    expect(parsed.map((p) => p.userId)).toContain(userId);
  });

  it("get_run response includes the attributions array", async () => {
    await callTool("claim_run", { instrumentId, runId });

    const result = await callTool("get_run", { instrumentId, runId });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(Array.isArray(parsed.attributions)).toBe(true);
    expect(parsed.attributions).toHaveLength(1);
    expect(parsed.attributions[0].userId).toBe(userId);
  });

  // ---- PAT scope enforcement -----------------------------------------------
  //
  // Each MCP tool calls `requireMcpScope(authInfo, "<resource>:<action>")`
  // matching its REST counterpart (see `lib/mcp/tools.ts`). These tests seed
  // a PAT with a narrow scope set and confirm that:
  //   - tools whose required scope is granted execute normally;
  //   - tools whose required scope is missing return `isError: true` with
  //     a "missing required scope: <scope>" message.
  //
  // The scope guard runs before any DB lookup, so we don't need to seed
  // the file/run referenced by the call — a non-existent id is fine since
  // the call should be rejected at the guard, not at the lookup.

  it("['runs:read'] can call search_runs but not claim_run", async () => {
    const { token: scopedToken } = await seedTestUser({
      scopes: ["runs:read"],
    });

    const search = await callTool("search_runs", { instrumentId }, scopedToken);
    expect(search.isError).toBeFalsy();

    const claim = await callTool(
      "claim_run",
      { instrumentId, runId },
      scopedToken
    );
    expect(claim.isError).toBe(true);
    expect(claim.content[0].text).toMatch(/missing required scope: runs:write/);
  });

  it("['files:read'] can call get_file but not reprocess_file", async () => {
    const { token: scopedToken } = await seedTestUser({
      scopes: ["files:read"],
    });

    // get_file with a nonexistent id still passes the scope guard; it
    // surfaces a "not found" error instead of a missing-scope error.
    const getFile = await callTool("get_file", { fileId: 99_999 }, scopedToken);
    expect(getFile.isError).toBe(true);
    expect(getFile.content[0].text).toMatch(/not found/);
    expect(getFile.content[0].text).not.toMatch(/missing required scope/);

    const reprocess = await callTool(
      "reprocess_file",
      { fileId: 99_999 },
      scopedToken
    );
    expect(reprocess.isError).toBe(true);
    expect(reprocess.content[0].text).toMatch(
      /missing required scope: files:write/
    );
  });

  it("['watchers:read'] can call list_watchers but not list_instruments", async () => {
    const { token: scopedToken } = await seedTestUser({
      scopes: ["watchers:read"],
    });

    const watchers = await callTool("list_watchers", {}, scopedToken);
    expect(watchers.isError).toBeFalsy();

    const instruments = await callTool("list_instruments", {}, scopedToken);
    expect(instruments.isError).toBe(true);
    expect(instruments.content[0].text).toMatch(
      /missing required scope: instruments:read/
    );
  });

  it("[] is denied on every protected tool", async () => {
    const { token: scopedToken } = await seedTestUser({ scopes: [] });

    for (const toolName of [
      "list_instruments",
      "search_runs",
      "list_watchers",
      "claim_run",
      "reprocess_file",
    ]) {
      const result = await callTool(
        toolName,
        toolName === "claim_run"
          ? { instrumentId, runId }
          : toolName === "reprocess_file"
            ? { fileId: 99_999 }
            : {},
        scopedToken
      );
      expect(result.isError, `expected ${toolName} to be denied`).toBe(true);
      expect(result.content[0].text).toMatch(/missing required scope/);
    }
  });
});
