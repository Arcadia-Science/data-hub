import { describe, expect, it } from "vitest";
import { parseRunStatusParam } from "@/lib/api/validators";
import {
  deriveRunStatus,
  RUN_STATUS_VALUES,
  type RunStatusCounts,
} from "@/lib/runs/run-status";

// Pure-function coverage for the two halves of the derived-status contract:
// `deriveRunStatus` (used by the icon) and `parseRunStatusParam` (used by both
// REST GET routes and the MCP tool). The SQL predicates that mirror this
// priority live in `buildRunListQuery` and are exercised by the integration
// suite (`tests/integration/run-status-filter.test.ts`).

const ZERO: RunStatusCounts = {
  filesCompleted: 0,
  filesFailed: 0,
  filesPendingUpload: 0,
  filesProcessing: 0,
  filesStalled: 0,
  filesUploaded: 0,
};

function counts(overrides: Partial<RunStatusCounts>): RunStatusCounts {
  return { ...ZERO, ...overrides };
}

describe("deriveRunStatus", () => {
  it("returns 'empty' when every bucket is zero", () => {
    expect(deriveRunStatus(ZERO)).toBe("empty");
  });

  it("maps each bucket to its status in isolation", () => {
    expect(deriveRunStatus(counts({ filesFailed: 1 }))).toBe("failed");
    expect(deriveRunStatus(counts({ filesStalled: 1 }))).toBe("stalled");
    expect(deriveRunStatus(counts({ filesPendingUpload: 1 }))).toBe("pending");
    expect(deriveRunStatus(counts({ filesUploaded: 1 }))).toBe("uploaded");
    expect(deriveRunStatus(counts({ filesProcessing: 1 }))).toBe("processing");
    expect(deriveRunStatus(counts({ filesCompleted: 1 }))).toBe("completed");
  });

  it("prefers 'failed' over every lower-priority bucket", () => {
    expect(
      deriveRunStatus(
        counts({
          filesFailed: 1,
          filesStalled: 1,
          filesPendingUpload: 1,
          filesUploaded: 1,
          filesProcessing: 1,
          filesCompleted: 1,
        })
      )
    ).toBe("failed");
  });

  // Stalled outranks everything but failed: the run needs someone to press
  // Reprocess, and a file merely waiting to upload would otherwise mask that.
  it("prefers 'stalled' over every bucket except 'failed'", () => {
    expect(
      deriveRunStatus(
        counts({
          filesStalled: 1,
          filesPendingUpload: 1,
          filesUploaded: 1,
          filesProcessing: 1,
          filesCompleted: 1,
        })
      )
    ).toBe("stalled");
  });

  // A run whose only unfinished file has stalled must stop claiming work is
  // under way — that was the bug this bucket exists to fix.
  it("reads a run with one stalled file and the rest complete as 'stalled'", () => {
    expect(
      deriveRunStatus(counts({ filesStalled: 1, filesCompleted: 5 }))
    ).toBe("stalled");
  });

  // The intentional behavior change: pending outranks completed, so a run with
  // both still-pending and already-completed files reads as "pending".
  it("prefers 'pending' over 'completed'", () => {
    expect(
      deriveRunStatus(counts({ filesPendingUpload: 1, filesCompleted: 5 }))
    ).toBe("pending");
  });

  it("prefers 'uploaded' over 'processing' and 'completed'", () => {
    expect(
      deriveRunStatus(
        counts({ filesUploaded: 1, filesProcessing: 1, filesCompleted: 1 })
      )
    ).toBe("uploaded");
  });

  it("prefers 'processing' over 'completed'", () => {
    expect(
      deriveRunStatus(counts({ filesProcessing: 1, filesCompleted: 1 }))
    ).toBe("processing");
  });
});

describe("parseRunStatusParam", () => {
  it("returns undefined when the param is absent", () => {
    expect(parseRunStatusParam(new URLSearchParams())).toBeUndefined();
  });

  it("parses a single value", () => {
    expect(parseRunStatusParam(new URLSearchParams("status=failed"))).toEqual([
      "failed",
    ]);
  });

  it("parses repeated params", () => {
    expect(
      parseRunStatusParam(new URLSearchParams("status=failed&status=empty"))
    ).toEqual(["failed", "empty"]);
  });

  it("parses a comma-separated list", () => {
    expect(
      parseRunStatusParam(new URLSearchParams("status=failed,empty"))
    ).toEqual(["failed", "empty"]);
  });

  it("trims whitespace around comma-separated values", () => {
    expect(
      parseRunStatusParam(new URLSearchParams("status=failed , empty"))
    ).toEqual(["failed", "empty"]);
  });

  it("drops unknown values but keeps the valid ones", () => {
    expect(
      parseRunStatusParam(new URLSearchParams("status=failed,bogus,empty"))
    ).toEqual(["failed", "empty"]);
  });

  it("returns undefined when every value is unknown", () => {
    expect(
      parseRunStatusParam(new URLSearchParams("status=bogus&status=nope"))
    ).toBeUndefined();
  });

  it("de-duplicates repeated values", () => {
    expect(
      parseRunStatusParam(
        new URLSearchParams("status=failed&status=failed,failed")
      )
    ).toEqual(["failed"]);
  });

  it("accepts every documented status value", () => {
    const query = RUN_STATUS_VALUES.join(",");
    expect(parseRunStatusParam(new URLSearchParams(`status=${query}`))).toEqual(
      [...RUN_STATUS_VALUES]
    );
  });
});
