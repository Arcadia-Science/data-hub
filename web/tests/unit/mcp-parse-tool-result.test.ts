import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { parseRunReportToolResult } from "@/mcp-apps/run-report/parse-tool-result";

const valid = {
  instrumentId: "gel-doc-1",
  runId: "run-9",
  instrumentType: "gel_doc",
  metadata: {},
  reportFiles: [],
};

describe("parseRunReportToolResult", () => {
  it("reads structured content", () => {
    expect(
      parseRunReportToolResult({
        content: [],
        structuredContent: valid,
      } as CallToolResult)
    ).toEqual(valid);
  });

  it("parses a text block once when structured content is missing", () => {
    expect(
      parseRunReportToolResult({
        content: [{ type: "text", text: JSON.stringify(valid) }],
      } as CallToolResult)
    ).toEqual(valid);
  });

  it("returns null for text that parses but lacks identifiers", () => {
    expect(
      parseRunReportToolResult({
        content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
      } as CallToolResult)
    ).toBeNull();
  });

  it("returns null for invalid JSON text", () => {
    expect(
      parseRunReportToolResult({
        content: [{ type: "text", text: "not-json" }],
      } as CallToolResult)
    ).toBeNull();
  });
});
