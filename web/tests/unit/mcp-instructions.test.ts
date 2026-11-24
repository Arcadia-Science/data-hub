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

  it("sends questions about what changed to the changelog tool", () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain("search_changelog");
  });

  it("asks clients to confirm before deleting or restoring files, deleting a lab notebook, reprocessing, or cancelling queued files", () => {
    const oneLine = MCP_SERVER_INSTRUCTIONS.replace(/\s+/g, " ");
    expect(oneLine).toContain(
      "Confirm before delete_files, restore_files, deleting a run, comment or lab notebook, dismissing, unclaiming, reprocessing, cancelling queued files, or changing a watcher's config."
    );
  });

  // The MCP client SDK fails a call with this text when the session's tool
  // list no longer matches a result. An assistant that knows the fix is to
  // reconnect doesn't report a server bug.
  it("tells the assistant to ask for a reconnect when a result doesn't match the tool's output schema", () => {
    const oneLine = MCP_SERVER_INSTRUCTIONS.replace(/\s+/g, " ");
    expect(oneLine).toContain(
      `"Structured content does not match the tool's output schema"`
    );
    expect(oneLine).toMatch(/ask the user to reconnect Data Hub/);
    expect(oneLine).toMatch(/new session/);
    expect(oneLine).toMatch(/feedback only if it still fails/);
  });

  it("sends lab notebook questions to the lab notebook tools", () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain("list_lab_notebooks");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("labNotebookId");
  });

  it("names the feedback tools the server registers", () => {
    expect(MCP_SERVER_INSTRUCTIONS).toContain("send_feedback");
    expect(MCP_SERVER_INSTRUCTIONS).toContain("add_run_comment");
  });
});
