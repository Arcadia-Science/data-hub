import { describe, expect, it } from "vitest";
import { filesFooter } from "@/lib/runs/files-footer";

const base = {
  activeTotal: 9,
  deletedCount: 0,
  page: 1,
  perPage: 15,
  showDeleted: false,
  total: 9,
};

describe("filesFooter", () => {
  it("counts the page, with no link when nothing is deleted", () => {
    expect(filesFooter(base)).toEqual({
      summary: "Showing 1–9 of 9",
      link: null,
    });
  });

  it("offers Show N deleted while deleted files match and are hidden", () => {
    expect(filesFooter({ ...base, deletedCount: 6 })).toEqual({
      summary: "Showing 1–9 of 9",
      link: { label: "Show 6 deleted", show: true },
    });
  });

  it("counts the deleted files and offers Hide deleted while they are shown", () => {
    expect(
      filesFooter({
        ...base,
        deletedCount: 6,
        showDeleted: true,
        total: 15,
        activeTotal: 9,
      })
    ).toEqual({
      summary: "Showing 1–15 of 15, including 6 deleted",
      link: { label: "Hide deleted", show: false },
    });
  });

  it("offers no link when deleted files are shown but none match", () => {
    expect(filesFooter({ ...base, showDeleted: true })).toEqual({
      summary: "Showing 1–9 of 9",
      link: null,
    });
  });

  it("works out the range of a later page", () => {
    expect(
      filesFooter({ ...base, page: 3, perPage: 10, total: 24 }).summary
    ).toBe("Showing 21–24 of 24");
  });

  it("says 0 of the run's files when the filters match none, and still offers the deleted ones", () => {
    expect(
      filesFooter({ ...base, total: 0, deletedCount: 2, activeTotal: 12 })
    ).toEqual({
      summary: "Showing 0 of 12",
      link: { label: "Show 2 deleted", show: true },
    });
  });
});
