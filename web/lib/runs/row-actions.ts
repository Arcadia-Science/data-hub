import type { RunRow } from "@/components/instruments/runs-table";
import type {
  RunCaps,
  RunRef,
  RunStats,
} from "@/components/instruments/runs-table/run-selection-provider";

// ---------------------------------------------------------------------------
// Predicates that decide which row-level / bulk actions are available for a
// given run. All predicates read only the aggregate counts already exposed
// on RunRow so they're cheap and can be called on every selection change.
//
// - Upload:    at least one file still waiting to be uploaded.
// - Download:  at least one file has made it to S3 (i.e. is not `detected`
//              or `upload_requested`).
// - Reprocess: at least one file is in `completed` or `failed` status.
// - Delete:    the run isn't already soft-deleted.
// ---------------------------------------------------------------------------

export function canUploadRun(row: RunRow): boolean {
  return row.deleted_at === null && row.files_pending_upload > 0;
}

export function canDownloadRun(row: RunRow): boolean {
  return (
    row.deleted_at === null &&
    row.file_count > 0 &&
    row.files_pending_upload < row.file_count
  );
}

export function canReprocessRun(row: RunRow): boolean {
  return row.deleted_at === null && row.files_completed + row.files_failed > 0;
}

export function canDeleteRun(row: RunRow): boolean {
  return row.deleted_at === null;
}

export function computeRunCaps(row: RunRow): RunCaps {
  return {
    upload: canUploadRun(row),
    download: canDownloadRun(row),
    reprocess: canReprocessRun(row),
    delete: canDeleteRun(row),
  };
}

export function computeRunStats(row: RunRow): RunStats {
  return {
    fileCount: row.file_count,
    filesCompleted: row.files_completed,
    filesFailed: row.files_failed,
  };
}

// Convenience helper used by every runs-table variant so the row → RunRef
// mapping stays in one place. Keeps the selection provider and row stats
// in sync: if we add another capability or count, we only touch here.
export function runRowToRef(row: RunRow): RunRef {
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    runId: row.run_id,
    caps: computeRunCaps(row),
    stats: computeRunStats(row),
  };
}
