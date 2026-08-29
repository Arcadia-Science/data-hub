import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { RunReportToolResult } from "./instrument-report";

function asRunReport(payload: unknown): RunReportToolResult | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Partial<RunReportToolResult>;
  if (!(record.instrumentId && record.runId && record.instrumentType)) {
    return null;
  }
  return {
    instrumentId: record.instrumentId,
    runId: record.runId,
    instrumentType: record.instrumentType,
    metadata: record.metadata,
    reportFiles: record.reportFiles ?? [],
  };
}

// Single pass over structured content, then one JSON parse of the text
// block. A recursive fallback would stack-overflow when the text parses
// but still lacks identifiers.
export function parseRunReportToolResult(
  result: CallToolResult
): RunReportToolResult | null {
  const fromStructured = asRunReport(result.structuredContent);
  if (fromStructured) {
    return fromStructured;
  }
  const text = result.content?.find((block) => block.type === "text");
  if (!(text && "text" in text)) {
    return null;
  }
  try {
    return asRunReport(JSON.parse(text.text));
  } catch {
    return null;
  }
}
