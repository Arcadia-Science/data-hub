import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// biome-ignore lint/performance/noNamespaceImport: integration tests need the full schema module for Db typing
import * as schema from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getBaseUrl,
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
    const res = await api("/mcp/v1", {
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
    const res = await api("/mcp/v1", {
      method: "POST",
      headers: MCP_HEADERS,
      body: jsonRpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      }),
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer\b/i);
    expect(challenge).toContain(
      `resource_metadata="${getBaseUrl()}/.well-known/oauth-protected-resource/mcp/v1"`
    );
    expect(challenge).toContain('scope="read write"');
  });

  // ---- Initialize ----------------------------------------------------------

  it("initializes with valid token", async () => {
    const res = await api("/mcp/v1", {
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
    const res = await api("/mcp/v1", {
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
    expect(toolNames).toContain("global_search");
    expect(toolNames).toContain("get_me");
    expect(toolNames).toContain("list_run_comments");
    expect(toolNames).toContain("reprocess_run");
    expect(toolNames).toContain("delete_run");
    expect(toolNames).toContain("dismiss_file");
    expect(toolNames).toContain("get_run_report");
    expect(toolNames).toContain("get_watcher");
    expect(toolNames).toContain("list_watcher_events");
    expect(toolNames).toHaveLength(30);
  });

  // ---- Tool execution (end-to-end) -----------------------------------------

  it("executes list_instruments tool against real DB", async () => {
    const res = await api("/mcp/v1", {
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

  it('search_runs ranBy="me" resolves to the token owner', async () => {
    await callTool("claim_run", { instrumentId, runId });

    const result = await callTool("search_runs", {
      instrumentId,
      ranBy: "me",
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    const runIds = parsed.data.map((r: { run_id: string }) => r.run_id);
    expect(runIds).toContain(runId);
  });

  it("get_me returns the authenticated token owner", async () => {
    const result = await callTool("get_me", {});
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe(userId);
    expect(parsed).toHaveProperty("email");
    expect(parsed).toHaveProperty("isAdmin");
  });

  it("global_search finds the seeded instrument by name", async () => {
    const result = await callTool("global_search", {
      query: "MCP Test",
      scope: "instruments",
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.instruments).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: instrumentId })])
    );
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

  // ---- Comment mutations (end-to-end) --------------------------------------
  //
  // Exercises the add/edit/delete tools through the HTTP boundary where a real
  // Bearer token resolves `authInfo.extra.userId`. Covers author-only
  // enforcement (a second user's token is rejected) and the documented
  // idempotency of delete_run_comment.

  it("add/edit/delete_run_comment round-trips and enforces author-only", async () => {
    const add = await callTool("add_run_comment", {
      instrumentId,
      runId,
      body: "hello from mcp",
    });
    expect(add.isError).toBeFalsy();
    const created = JSON.parse(add.content[0].text) as { id: string };
    expect(created.id).toBeTruthy();

    // A different user cannot edit or delete the comment.
    const editOther = await callTool(
      "edit_run_comment",
      { commentId: created.id, body: "tampered" },
      tokenB
    );
    expect(editOther.isError).toBe(true);
    expect(editOther.content[0].text).toMatch(/only edit your own/i);

    const deleteOther = await callTool(
      "delete_run_comment",
      { commentId: created.id },
      tokenB
    );
    expect(deleteOther.isError).toBe(true);
    expect(deleteOther.content[0].text).toMatch(/only delete your own/i);

    const edit = await callTool("edit_run_comment", {
      commentId: created.id,
      body: "edited body",
    });
    expect(edit.isError).toBeFalsy();
    expect(JSON.parse(edit.content[0].text).body).toBe("edited body");

    // Deleting twice both succeed — the tool is documented as idempotent.
    const del1 = await callTool("delete_run_comment", {
      commentId: created.id,
    });
    expect(del1.isError).toBeFalsy();
    expect(JSON.parse(del1.content[0].text).deleted).toBe(true);

    const del2 = await callTool("delete_run_comment", {
      commentId: created.id,
    });
    expect(del2.isError).toBeFalsy();
    expect(JSON.parse(del2.content[0].text).deleted).toBe(true);
  });

  // ---- Upload requests (end-to-end) ----------------------------------------

  it("request_run_upload queues detected files and rejects unknown ids", async () => {
    const db = getTestDb();
    const uploadInstrument = "mcp-upload-instrument";
    const uploadRun = "mcp-upload-run";

    await db.insert(schema.instruments).values({
      id: uploadInstrument,
      displayName: "MCP Upload Instrument",
      status: "active",
      instrumentType: "plate_reader",
    });
    await db.insert(schema.watchers).values({
      instrumentId: uploadInstrument,
      hostname: "online-pc",
      status: "watching",
      lastHeartbeatAt: new Date(),
    });
    const [run] = await db
      .insert(schema.instrumentRuns)
      .values({
        instrumentId: uploadInstrument,
        runId: uploadRun,
        source: "watcher",
      })
      .returning({ id: schema.instrumentRuns.id });
    const inserted = await db
      .insert(schema.files)
      .values([
        { instrumentRunId: run.id, filename: "a.csv", relativePath: "a.csv" },
        { instrumentRunId: run.id, filename: "b.csv", relativePath: "b.csv" },
      ])
      .returning({ id: schema.files.id });
    const uploadFileIds = inserted.map((f) => f.id);

    const ok = await callTool("request_run_upload", {
      instrumentId: uploadInstrument,
      runId: uploadRun,
      fileIds: uploadFileIds,
    });
    expect(ok.isError).toBeFalsy();
    expect(JSON.parse(ok.content[0].text).filesQueued).toBe(2);

    // An id that isn't part of this run is rejected by the shared helper.
    const badId = await callTool("request_run_upload", {
      instrumentId: uploadInstrument,
      runId: uploadRun,
      fileIds: [999_999],
    });
    expect(badId.isError).toBe(true);
    expect(badId.content[0].text).toMatch(/not found/i);
  });

  // ---- Delete / restore round-trip (end-to-end) ----------------------------

  it("delete_run then restore_run round-trips the soft-delete", async () => {
    const db = getTestDb();
    const lifecycleInstrument = "mcp-lifecycle-instrument";
    const lifecycleRun = "mcp-lifecycle-run";

    await db.insert(schema.instruments).values({
      id: lifecycleInstrument,
      displayName: "MCP Lifecycle Instrument",
      status: "active",
      instrumentType: "plate_reader",
    });
    await db.insert(schema.instrumentRuns).values({
      instrumentId: lifecycleInstrument,
      runId: lifecycleRun,
      source: "lambda",
    });

    const del = await callTool("delete_run", {
      instrumentId: lifecycleInstrument,
      runId: lifecycleRun,
    });
    expect(del.isError).toBeFalsy();
    const delParsed = JSON.parse(del.content[0].text);
    expect(delParsed.deletedAt).toBeTruthy();
    expect(delParsed.alreadyApplied).toBe(false);

    // Deleting again is an idempotent no-op: still success, flagged as such,
    // and the original deletion timestamp is preserved.
    const delAgain = await callTool("delete_run", {
      instrumentId: lifecycleInstrument,
      runId: lifecycleRun,
    });
    expect(delAgain.isError).toBeFalsy();
    const delAgainParsed = JSON.parse(delAgain.content[0].text);
    expect(delAgainParsed.alreadyApplied).toBe(true);
    expect(delAgainParsed.deletedAt).toBe(delParsed.deletedAt);

    // get_run still resolves the run but now surfaces the soft-delete stamp.
    const afterDelete = await callTool("get_run", {
      instrumentId: lifecycleInstrument,
      runId: lifecycleRun,
    });
    expect(afterDelete.isError).toBeFalsy();
    expect(JSON.parse(afterDelete.content[0].text).deletedAt).toBeTruthy();

    const restore = await callTool("restore_run", {
      instrumentId: lifecycleInstrument,
      runId: lifecycleRun,
    });
    expect(restore.isError).toBeFalsy();
    const restoreParsed = JSON.parse(restore.content[0].text);
    expect(restoreParsed.deletedAt).toBeNull();
    expect(restoreParsed.alreadyApplied).toBe(false);

    // Restoring an already-live run is an idempotent no-op.
    const restoreAgain = await callTool("restore_run", {
      instrumentId: lifecycleInstrument,
      runId: lifecycleRun,
    });
    expect(restoreAgain.isError).toBeFalsy();
    const restoreAgainParsed = JSON.parse(restoreAgain.content[0].text);
    expect(restoreAgainParsed.deletedAt).toBeNull();
    expect(restoreAgainParsed.alreadyApplied).toBe(true);

    const afterRestore = await callTool("get_run", {
      instrumentId: lifecycleInstrument,
      runId: lifecycleRun,
    });
    expect(afterRestore.isError).toBeFalsy();
    expect(JSON.parse(afterRestore.content[0].text).deletedAt).toBeNull();
  });

  // ---- PAT scope enforcement (coarse read / write) -------------------------
  //
  // Transport requires `read` only. The WWW-Authenticate challenge still
  // advertises `read write` so Cursor requests both. PAT fallback maps to
  // `read` always and `write` only for `*` (fine-grained mutating PAT scopes
  // stay read-only over MCP to avoid privilege escalation). Mutating tools
  // gate on `write` via `requireMcpWrite`.

  it("read-only PAT can read but not mutate", async () => {
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
    expect(claim.content[0].text).toMatch(/missing required scope: write/);
  });

  it("fine-grained mutating PAT scopes stay read-only over MCP", async () => {
    const { token: scopedToken } = await seedTestUser({
      scopes: ["runs:attribute"],
    });

    const search = await callTool("search_runs", { instrumentId }, scopedToken);
    expect(search.isError).toBeFalsy();

    const claim = await callTool(
      "claim_run",
      { instrumentId, runId },
      scopedToken
    );
    expect(claim.isError).toBe(true);
    expect(claim.content[0].text).toMatch(/missing required scope: write/);
  });

  it("wildcard PAT can call mutating tools", async () => {
    const { token: scopedToken } = await seedTestUser({
      scopes: ["*"],
    });

    const claim = await callTool(
      "claim_run",
      { instrumentId, runId },
      scopedToken
    );
    expect(claim.isError).toBeFalsy();

    // Nonexistent file: write gate passes, then the helper returns not-found.
    const reprocess = await callTool(
      "reprocess_file",
      { fileId: 99_999 },
      scopedToken
    );
    expect(reprocess.isError).toBe(true);
    expect(reprocess.content[0].text).toMatch(/not found/);
    expect(reprocess.content[0].text).not.toMatch(/missing required scope/);
  });

  it("empty PAT scopes can read (read is always granted) but not mutate", async () => {
    const { token: scopedToken } = await seedTestUser({ scopes: [] });

    const list = await callTool("list_instruments", {}, scopedToken);
    expect(list.isError).toBeFalsy();

    const claim = await callTool(
      "claim_run",
      { instrumentId, runId },
      scopedToken
    );
    expect(claim.isError).toBe(true);
    expect(claim.content[0].text).toMatch(/missing required scope: write/);
  });
});
