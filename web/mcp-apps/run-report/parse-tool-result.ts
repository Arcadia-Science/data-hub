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

// Deliberately not recursive: a self-call would never stop when the text
// block parses cleanly but still has no run identifiers in it.
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
