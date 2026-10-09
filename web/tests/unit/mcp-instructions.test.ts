import { describe, expect, it } from "vitest";
import { MCP_SERVER_INSTRUCTIONS } from "@/lib/mcp/instructions";

describe("MCP server instructions", () => {
  // Claude Code keeps the first 2 KB of server instructions and drops the
  // rest, so text past the limit never reaches the model.
  it("fits in the 2 KB Claude Code keeps", () => {
    expect(Buffer.byteLength(MCP_SERVER_INSTRUCTIONS)).toBeLessThanOrEqual(
      2048
    );
  });

  it("sends how-to questions about Data Hub to the docs tools", () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain("search_docs");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("read_doc");
  });

  it("names the feedback tools the server registers", () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain("send_feedback");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("add_run_comment");
  });
});
