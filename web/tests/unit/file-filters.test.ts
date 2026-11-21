import { describe, expect, it } from "vitest";
import {
  countActiveFileFilters,
  narrowsFileDownload,
} from "@/lib/runs/file-filters";

describe("countActiveFileFilters", () => {
  const none = { categories: [], showDeleted: false, statuses: [] };

  it("is zero when nothing is chosen", () => {
    expect(countActiveFileFilters(none)).toBe(0);
  });

  it("counts showing deleted files as one", () => {
    expect(countActiveFileFilters({ ...none, showDeleted: true })).toBe(1);
  });

  it("counts every type and every status chosen", () => {
    expect(
      countActiveFileFilters({
        categories: ["raw", "processed"],
        showDeleted: true,
        statuses: ["failed", "stalled", "queued"],
      })
    ).toBe(6);
  });
});

describe("narrowsFileDownload", () => {
  const none = { categories: [], search: "", statuses: [] };

  it("is false with no search and no filters", () => {
    expect(narrowsFileDownload(none)).toBe(false);
  });

  it("is false for a search of only spaces", () => {
    expect(narrowsFileDownload({ ...none, search: "   " })).toBe(false);
  });

  it("is true for a search, a type, or a status", () => {
    expect(narrowsFileDownload({ ...none, search: "blot" })).toBe(true);
    expect(narrowsFileDownload({ ...none, categories: ["raw"] })).toBe(true);
    expect(narrowsFileDownload({ ...none, statuses: ["failed"] })).toBe(true);
  });
});
