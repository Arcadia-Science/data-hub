import { describe, expect, it } from "vitest";
import { parseRunStatusParam } from "@/lib/api/validators";
import {
  deriveRunStatus,
  expandRunStatusAlias,
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
  filesNotUploaded: 0,
  filesQueued: 0,
  filesProcessing: 0,
  filesStalled: 0,
  filesUploadFailed: 0,
  filesUploaded: 0,
  filesWaitingUpload: 0,
};

const ALL_ONES: RunStatusCounts = {
  filesCompleted: 1,
  filesFailed: 1,
  filesNotUploaded: 1,
  filesQueued: 1,
  filesProcessing: 1,
  filesStalled: 1,
  filesUploadFailed: 1,
  filesUploaded: 1,
  filesWaitingUpload: 1,
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
    expect(deriveRunStatus(counts({ filesUploadFailed: 1 }))).toBe(
      "upload_failed"
    );
    expect(deriveRunStatus(counts({ filesWaitingUpload: 1 }))).toBe(
      "waiting_upload"
    );
    expect(deriveRunStatus(counts({ filesUploaded: 1 }))).toBe("uploaded");
    expect(deriveRunStatus(counts({ filesQueued: 1 }))).toBe("queued");
    expect(deriveRunStatus(counts({ filesProcessing: 1 }))).toBe("processing");
    expect(deriveRunStatus(counts({ filesNotUploaded: 1 }))).toBe(
      "not_uploaded"
    );
    expect(deriveRunStatus(counts({ filesCompleted: 1 }))).toBe("completed");
  });

  it("follows RUN_STATUS_VALUES: each bucket beats every bucket below it", () => {
    const order: [keyof RunStatusCounts, string][] = [
      ["filesFailed", "failed"],
      ["filesStalled", "stalled"],
      ["filesUploadFailed", "upload_failed"],
      ["filesWaitingUpload", "waiting_upload"],
      ["filesUploaded", "uploaded"],
      ["filesQueued", "queued"],
      ["filesProcessing", "processing"],
      ["filesNotUploaded", "not_uploaded"],
      ["filesCompleted", "completed"],
    ];
    expect(order.map(([, status]) => status)).toEqual(
      RUN_STATUS_VALUES.filter((status) => status !== "empty")
    );
    let remaining = { ...ALL_ONES };
    for (const [field, status] of order) {
      expect(deriveRunStatus(remaining)).toBe(status);
      remaining = { ...remaining, [field]: 0 };
    }
    expect(deriveRunStatus(remaining)).toBe("empty");
  });

  // Upload failed needs someone to act on the instrument PC, so it outranks
  // the files that are still on their way.
  it("prefers 'upload_failed' over 'waiting_upload' and 'completed'", () => {
    expect(
      deriveRunStatus(
        counts({
          filesUploadFailed: 1,
          filesWaitingUpload: 3,
          filesCompleted: 5,
        })
      )
    ).toBe("upload_failed");
  });

  // A run whose only unfinished file has stalled must stop claiming work is
  // under way — that was the bug this bucket exists to fix.
  it("reads a run with one stalled file and the rest complete as 'stalled'", () => {
    expect(
      deriveRunStatus(counts({ filesStalled: 1, filesCompleted: 5 }))
    ).toBe("stalled");
  });

  // Files on their way outrank completed ones, as "pending" did.
  it("prefers 'waiting_upload' over 'processing' and 'completed'", () => {
    expect(
      deriveRunStatus(
        counts({ filesWaitingUpload: 1, filesProcessing: 1, filesCompleted: 5 })
      )
    ).toBe("waiting_upload");
  });

  // Files nobody requested are a resting state: processing still shows, and a
  // run whose other files are all done reads "Not uploaded", not "Completed".
  it("ranks 'not_uploaded' below the processing states and above 'completed'", () => {
    expect(
      deriveRunStatus(counts({ filesNotUploaded: 285, filesProcessing: 2 }))
    ).toBe("processing");
    expect(
      deriveRunStatus(counts({ filesNotUploaded: 285, filesCompleted: 3 }))
    ).toBe("not_uploaded");
  });

  // Queued ranks between uploaded and processing: a run that is still
  // waiting on files reads as waiting even while other files process.
  it("ranks 'queued' directly between 'uploaded' and 'processing'", () => {
    expect(RUN_STATUS_VALUES.indexOf("queued")).toBe(
      RUN_STATUS_VALUES.indexOf("uploaded") + 1
    );
    expect(RUN_STATUS_VALUES.indexOf("processing")).toBe(
      RUN_STATUS_VALUES.indexOf("queued") + 1
    );
  });
});

describe("expandRunStatusAlias", () => {
  it("expands the deprecated 'pending' to both statuses that replaced it", () => {
    expect(expandRunStatusAlias("pending")).toEqual([
      "waiting_upload",
      "not_uploaded",
    ]);
  });

  it("passes every other value through", () => {
    expect(expandRunStatusAlias("failed")).toEqual(["failed"]);
    expect(expandRunStatusAlias("bogus")).toEqual(["bogus"]);
  });

  it("isn't itself a status a run can have", () => {
    expect(RUN_STATUS_VALUES).not.toContain("pending");
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

  it("reads the deprecated 'pending' as both statuses that replaced it", () => {
    expect(
      parseRunStatusParam(new URLSearchParams("status=pending,failed"))
    ).toEqual(["waiting_upload", "not_uploaded", "failed"]);
  });

  it("de-duplicates 'pending' against a status it expands to", () => {
    expect(
      parseRunStatusParam(new URLSearchParams("status=not_uploaded,pending"))
    ).toEqual(["not_uploaded", "waiting_upload"]);
  });
});
