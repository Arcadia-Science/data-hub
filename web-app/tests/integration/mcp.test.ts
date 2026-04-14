import * as schema from "@/lib/db/schema";
import {
  api,
  closeTestDb,
  getTestDb,
  resetDb,
  seedTestUser,
} from "@/tests/integration/helpers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function jsonRpc(method: string, params: unknown = {}, id: number = 1) {
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
      if (!dataLine) return null;
      return JSON.parse(dataLine.slice("data: ".length));
    })
    .filter(Boolean);
  return events[events.length - 1];
}

describe("MCP Server (HTTP)", () => {
  let token: string;

  beforeAll(async () => {
    await resetDb();
    ({ token } = await seedTestUser());

    const db = getTestDb();
    await db.insert(schema.instruments).values({
      id: "mcp-test-instrument",
      displayName: "MCP Test Instrument",
      status: "active",
      instrumentType: "plate_reader",
    });
  });

  afterAll(async () => {
    await closeTestDb();
  });

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
    expect(toolNames).toContain("get_run_report_data");
    expect(toolNames).toContain("list_run_files");
    expect(toolNames).toContain("get_system_status");
    expect(toolNames).toContain("list_watchers");
    expect(toolNames).toHaveLength(8);
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
      expect.arrayContaining([
        expect.objectContaining({ id: "mcp-test-instrument" }),
      ])
    );
  });
});
