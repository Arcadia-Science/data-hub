import { describe, expect, it } from "vitest";
import { canCancelQueued, cancelQueuedToast } from "@/lib/runs/cancel-queued";

// The run page decides from the file counts alone whether to show the Cancel
// queued button, so a wrong condition hides it when files are stuck in the
// queue or shows it when there is nothing to cancel.

describe("canCancelQueued", () => {
  it("is true when at least one file is queued", () => {
    expect(canCancelQueued({ queued: 1 })).toBe(true);
    expect(canCancelQueued({ queued: 80 })).toBe(true);
  });

  it("is false when no file is queued", () => {
    expect(canCancelQueued({ queued: 0 })).toBe(false);
  });
});

describe("cancelQueuedToast", () => {
  it("names the number of files, in the singular and the plural", () => {
    expect(cancelQueuedToast(1)).toEqual({
      kind: "success",
      message: "Cancelled 1 queued file",
    });
    expect(cancelQueuedToast(12)).toEqual({
      kind: "success",
      message: "Cancelled 12 queued files",
    });
  });

  it("says so when the files started before the request arrived", () => {
    expect(cancelQueuedToast(0)).toEqual({
      kind: "info",
      message: "No files were waiting in the queue",
    });
  });
});
