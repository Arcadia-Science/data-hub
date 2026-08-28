import { describe, expect, it } from "vitest";
import { mcpCorsPreflight, withMcpCors } from "@/lib/mcp/cors";

describe("MCP CORS", () => {
  it("answers preflight without requiring auth", () => {
    const response = mcpCorsPreflight();
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Access-Control-Allow-Headers")).toMatch(
      /Authorization/
    );
  });

  it("copies CORS onto an existing MCP response", async () => {
    const inner = new Response("ok", {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
    const wrapped = withMcpCors(inner);
    expect(wrapped.status).toBe(200);
    expect(wrapped.headers.get("Content-Type")).toBe("text/plain");
    expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await wrapped.text()).toBe("ok");
  });
});
