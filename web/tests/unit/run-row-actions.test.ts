import { describe, expect, it } from "vitest";
import type { RunRow } from "@/components/instruments/runs-table";
import {
  canDeleteRun,
  canDownloadRun,
  canReprocessRun,
  canUploadRun,
  computeRunStats,
  reprocessableFileCount,
} from "@/lib/runs/row-actions";

// The row menu and bulk bar decide what to offer from these predicates alone,
// so a bucket missing here silently hides an action the API would have
// accepted — which is exactly how stalled runs lost their Reprocess entry.

const BASE: RunRow = {
  id: "11111111-1111-4111-a111-111111111111",
  instrument_id: "test-plate-reader",
  instrument_display_name: "Test Plate Reader",
  instrument_type: "plate_reader",
  run_id: "run-1",
  source: "watcher",
  metadata: {},
  created_at: new Date("2025-01-01T00:00:00.000Z"),
  acquired_at: new Date("2025-01-01T00:00:00.000Z"),
  updated_at: new Date("2025-01-01T00:00:00.000Z"),
  deleted_at: null,
  file_count: 0,
  files_completed: 0,
  files_failed: 0,
  files_pending_upload: 0,
  files_uploaded: 0,
  files_processing: 0,
  files_stalled: 0,
  total_size_bytes: 0,
  error_messages: [],
  comment_count: 0,
  attributions: [],
};

function row(overrides: Partial<RunRow>): RunRow {
  return { ...BASE, ...overrides };
}

describe("canReprocessRun", () => {
  it("allows a run whose only unfinished file has stalled", () => {
    expect(canReprocessRun(row({ file_count: 1, files_stalled: 1 }))).toBe(
      true
    );
  });

  it("allows uploaded, failed, and completed files on their own", () => {
    expect(canReprocessRun(row({ file_count: 1, files_uploaded: 1 }))).toBe(
      true
    );
    expect(canReprocessRun(row({ file_count: 1, files_failed: 1 }))).toBe(true);
    expect(canReprocessRun(row({ file_count: 1, files_completed: 1 }))).toBe(
      true
    );
  });

  it("rejects a run whose files are all still inside the stall window", () => {
    expect(canReprocessRun(row({ file_count: 1, files_processing: 1 }))).toBe(
      false
    );
  });

  it("rejects runs with nothing to reprocess, soft-deleted runs, and instrument types with no processor", () => {
    expect(
      canReprocessRun(row({ file_count: 1, files_pending_upload: 1 }))
    ).toBe(false);
    expect(
      canReprocessRun(
        row({
          file_count: 1,
          files_stalled: 1,
          deleted_at: new Date("2025-02-01T00:00:00.000Z"),
        })
      )
    ).toBe(false);
    expect(
      canReprocessRun(
        row({
          file_count: 1,
          files_stalled: 1,
          instrument_type: "generic",
        })
      )
    ).toBe(false);
  });
});

describe("reprocessableFileCount", () => {
  it("sums every bucket the run reprocess endpoint would queue", () => {
    expect(
      reprocessableFileCount(
        row({
          file_count: 6,
          files_uploaded: 1,
          files_failed: 2,
          files_completed: 3,
          files_stalled: 4,
          files_pending_upload: 5,
          files_processing: 6,
        })
      )
    ).toBe(10);
  });

  it("is what the confirmation dialog counts", () => {
    const stalled = row({ file_count: 2, files_stalled: 2 });
    expect(computeRunStats(stalled).reprocessableFileCount).toBe(2);
  });
});

describe("the other row capabilities", () => {
  it("offers upload only while files are still on the instrument PC", () => {
    expect(canUploadRun(row({ file_count: 1, files_pending_upload: 1 }))).toBe(
      true
    );
    expect(canUploadRun(row({ file_count: 1, files_completed: 1 }))).toBe(
      false
    );
  });

  it("offers download once at least one file has reached S3", () => {
    expect(
      canDownloadRun(row({ file_count: 2, files_pending_upload: 1 }))
    ).toBe(true);
    expect(
      canDownloadRun(row({ file_count: 2, files_pending_upload: 2 }))
    ).toBe(false);
    expect(canDownloadRun(BASE)).toBe(false);
  });

  it("hides every action on a soft-deleted run", () => {
    const deleted = row({
      file_count: 1,
      files_completed: 1,
      deleted_at: new Date("2025-02-01T00:00:00.000Z"),
    });
    expect(canUploadRun(deleted)).toBe(false);
    expect(canDownloadRun(deleted)).toBe(false);
    expect(canReprocessRun(deleted)).toBe(false);
    expect(canDeleteRun(deleted)).toBe(false);
  });
});
