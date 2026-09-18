import { describe, expect, it } from "vitest";
import {
  formatRunFailureLine,
  formatRunFileLine,
  formatRunGroupSummary,
} from "@/lib/notifications/run-row-copy";

describe("formatRunFileLine", () => {
  it("returns No files when the run is empty", () => {
    expect(formatRunFileLine(0, 0)).toBe("No files");
  });

  it("pluralizes a healthy file count", () => {
    expect(formatRunFileLine(1, 0)).toBe("1 file");
    expect(formatRunFileLine(12, 0)).toBe("12 files");
  });

  it("shows surviving of total when some files failed", () => {
    expect(formatRunFileLine(9, 2)).toBe("7 of 9 files");
    expect(formatRunFileLine(1, 1)).toBe("0 of 1 file");
  });
});

describe("formatRunFailureLine", () => {
  it("matches the bell mock copy", () => {
    expect(formatRunFailureLine(9, 2)).toBe("2 of 9 files failed to upload");
  });
});

describe("formatRunGroupSummary", () => {
  it("says new when every run is unread", () => {
    expect(formatRunGroupSummary(13, 13)).toBe("13 new runs");
    expect(formatRunGroupSummary(1, 1)).toBe("1 new run");
  });

  it("counts only unread when the group is mixed", () => {
    expect(formatRunGroupSummary(13, 3)).toBe("3 new runs");
  });

  it("drops new once everything is read", () => {
    expect(formatRunGroupSummary(8, 0)).toBe("8 runs");
  });
});
