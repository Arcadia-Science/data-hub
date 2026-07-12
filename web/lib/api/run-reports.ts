import { and, eq, isNull } from "drizzle-orm";
import {
  getProcessedCsvData,
  getRunImageFiles,
  getRunReportFiles,
  lookupRunByNaturalKey,
  type RunFile,
} from "@/lib/api/instrument-runs";
import { db } from "@/lib/db";
import { files } from "@/lib/db/schema";

// Keep agent payloads small: enough to reason, not a full plate grid dump.
export const RUN_REPORT_CSV_SAMPLE_ROWS = 20;
export const RUN_REPORT_ERROR_MESSAGE_MAX = 500;

export interface RunFailureSummary {
  byStatus: Record<string, number>;
  failed: Array<{
    id: number;
    filename: string;
    errorMessage: string | null;
  }>;
  totalFiles: number;
}

export async function getRunFailureSummary(
  runInternalId: string
): Promise<RunFailureSummary> {
  const rows = await db
    .select({
      id: files.id,
      filename: files.filename,
      status: files.status,
      errorMessage: files.errorMessage,
    })
    .from(files)
    .where(
      and(eq(files.instrumentRunId, runInternalId), isNull(files.deletedAt))
    );

  const byStatus: Record<string, number> = {};
  const failed: RunFailureSummary["failed"] = [];

  for (const row of rows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    if (row.status === "failed") {
      failed.push({
        id: row.id,
        filename: row.filename,
        errorMessage: truncateError(row.errorMessage),
      });
    }
  }

  return { byStatus, failed, totalFiles: rows.length };
}

function truncateError(message: string | null): string | null {
  if (!message) {
    return null;
  }
  if (message.length <= RUN_REPORT_ERROR_MESSAGE_MAX) {
    return message;
  }
  return `${message.slice(0, RUN_REPORT_ERROR_MESSAGE_MAX)}…`;
}

function toReportFileRef(f: RunFile) {
  return {
    id: f.id,
    filename: f.filename,
    category: f.category,
    contentType: f.contentType,
    status: f.status,
    sizeBytes: f.sizeBytes,
  };
}

export type RunReportResult =
  | {
      ok: true;
      instrumentId: string;
      runId: string;
      instrumentType: string;
      metadata: unknown;
      fileCounts: Record<string, number>;
      processedCsv: {
        rowCount: number;
        columns: string[];
        sampleRows: Record<string, string>[];
        sampleRowLimit: number;
      } | null;
      images: ReturnType<typeof toReportFileRef>[];
      reportFiles: ReturnType<typeof toReportFileRef>[];
      failureSummary: RunFailureSummary;
    }
  | { ok: false; message: string };

// Bounded, analysis-ready summary for MCP agents — prefer this over downloading
// full CSVs via `get_file_download_url`.
export async function buildRunReport(
  instrumentId: string,
  runId: string
): Promise<RunReportResult> {
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    return {
      ok: false,
      message: `Run '${runId}' not found for instrument '${instrumentId}'.`,
    };
  }

  const [failureSummary, reportFiles, imageFiles] = await Promise.all([
    getRunFailureSummary(run.id),
    getRunReportFiles(run.id),
    getRunImageFiles(run.id),
  ]);

  const wellData = await getProcessedCsvData(reportFiles);
  const columns =
    wellData.length > 0 ? Object.keys(wellData[0]).sort() : ([] as string[]);
  const sampleRows = wellData.slice(0, RUN_REPORT_CSV_SAMPLE_ROWS);
  const processedCsv =
    wellData.length > 0
      ? {
          rowCount: wellData.length,
          columns,
          sampleRows,
          sampleRowLimit: RUN_REPORT_CSV_SAMPLE_ROWS,
        }
      : null;

  return {
    ok: true,
    instrumentId: run.instrumentId,
    runId: run.runId,
    instrumentType: run.instrumentType,
    metadata: run.metadata,
    fileCounts: failureSummary.byStatus,
    processedCsv,
    images: imageFiles.map(toReportFileRef),
    reportFiles: reportFiles.map(toReportFileRef),
    failureSummary,
  };
}
