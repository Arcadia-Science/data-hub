import {
  ARCHIVE_BUILD_RETRY_AFTER_MAX_SECONDS,
  ARCHIVE_BUILD_RETRY_AFTER_SECONDS,
  estimateRetryAfterSeconds,
} from "@/lib/api/run-archive";
import { describe, expect, it } from "vitest";

describe("estimateRetryAfterSeconds", () => {
  it("returns the floor for a tiny single-file run", () => {
    expect(estimateRetryAfterSeconds({ fileCount: 1, totalBytes: 1024 })).toBe(
      ARCHIVE_BUILD_RETRY_AFTER_SECONDS
    );
  });

  it("scales with file count for many small files", () => {
    // 3000 tiny files: per-file term dominates (3 + 3000*0.005 = 18s); the
    // ~6 MB byte term adds a fraction that rounds up to 19s.
    const seconds = estimateRetryAfterSeconds({
      fileCount: 3000,
      totalBytes: 3000 * 2 * 1024,
    });
    expect(seconds).toBe(19);
  });

  it("scales with total bytes for a few large files", () => {
    // ~10 GB across 3 files: throughput term (~51s) dominates and clamps to
    // the cap.
    const seconds = estimateRetryAfterSeconds({
      fileCount: 3,
      totalBytes: 10 * 1024 * 1024 * 1024,
    });
    expect(seconds).toBe(ARCHIVE_BUILD_RETRY_AFTER_MAX_SECONDS);
  });

  it("clamps to the ceiling for enormous runs", () => {
    expect(
      estimateRetryAfterSeconds({
        fileCount: 1_000_000,
        totalBytes: Number.MAX_SAFE_INTEGER,
      })
    ).toBe(ARCHIVE_BUILD_RETRY_AFTER_MAX_SECONDS);
  });

  it("treats zero bytes (all-NULL sizes) as a count-only estimate", () => {
    // The bytes term vanishes; the per-file term still applies. 2000 files:
    // 3 + 2000*0.005 = 13s.
    expect(estimateRetryAfterSeconds({ fileCount: 2000, totalBytes: 0 })).toBe(
      13
    );
  });

  it("never returns a value below the floor", () => {
    expect(
      estimateRetryAfterSeconds({ fileCount: 0, totalBytes: 0 })
    ).toBeGreaterThanOrEqual(ARCHIVE_BUILD_RETRY_AFTER_SECONDS);
  });
});
