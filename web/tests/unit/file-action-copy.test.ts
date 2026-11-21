import { describe, expect, it } from "vitest";
import {
  fileActionDialogCopy,
  fileActionMessage,
  linkedFilesHelp,
} from "@/lib/runs/file-action-copy";

describe("fileActionMessage", () => {
  it("says all were deleted", () => {
    expect(fileActionMessage("delete", { done: 7, failed: 0 })).toEqual({
      kind: "success",
      text: "Deleted 7 files",
    });
    expect(fileActionMessage("delete", { done: 1, failed: 0 }).text).toBe(
      "Deleted 1 file"
    );
  });

  it("counts both when some failed", () => {
    expect(fileActionMessage("delete", { done: 5, failed: 2 })).toEqual({
      kind: "warning",
      text: "Deleted 5 files, 2 failed",
    });
  });

  it("says all failed", () => {
    expect(fileActionMessage("delete", { done: 0, failed: 3 })).toEqual({
      kind: "error",
      text: "Failed to delete 3 files",
    });
    expect(fileActionMessage("restore", { done: 0, failed: 1 }).text).toBe(
      "Failed to restore 1 file"
    );
  });

  it("uses the same three messages for a restore", () => {
    expect(fileActionMessage("restore", { done: 7, failed: 0 }).text).toBe(
      "Restored 7 files"
    );
    expect(fileActionMessage("restore", { done: 4, failed: 1 }).text).toBe(
      "Restored 4 files, 1 failed"
    );
  });
});

describe("fileActionDialogCopy", () => {
  it("titles the dialog for one file or several", () => {
    const one = fileActionDialogCopy("delete", {
      requested: 1,
      linked: 0,
      includeLinked: true,
    });
    expect(one.title).toBe("Delete file?");
    expect(
      fileActionDialogCopy("delete", {
        requested: 2,
        linked: 0,
        includeLinked: true,
      }).title
    ).toBe("Delete 2 files?");
  });

  it("explains that deleted files stay in storage and can be restored", () => {
    expect(
      fileActionDialogCopy("delete", {
        requested: 2,
        linked: 0,
        includeLinked: true,
      }).description
    ).toBe(
      "Deleted files are hidden from this run, from downloads, and from the API. They stay in storage, and you can restore them later."
    );
  });

  it("counts the linked files in the button while they are included", () => {
    const counts = { requested: 2, linked: 5 };
    expect(
      fileActionDialogCopy("delete", { ...counts, includeLinked: true })
    ).toMatchObject({
      confirm: "Delete 7 files",
      linkedLabel: "Also delete 5 linked files",
    });
    expect(
      fileActionDialogCopy("delete", { ...counts, includeLinked: false })
        .confirm
    ).toBe("Delete 2 files");
  });

  it("takes the linked files along only when it lists some and the box is checked", () => {
    const counts = { requested: 2, linked: 5 };
    expect(
      fileActionDialogCopy("delete", { ...counts, includeLinked: true })
        .includeLinked
    ).toBe(true);
    expect(
      fileActionDialogCopy("delete", { ...counts, includeLinked: false })
        .includeLinked
    ).toBe(false);
    // While the lookup runs, or after it failed, the dialog lists none, so the
    // request must not take any along behind the button's count.
    expect(
      fileActionDialogCopy("delete", {
        requested: 2,
        linked: 0,
        includeLinked: true,
      })
    ).toMatchObject({ includeLinked: false, confirm: "Delete 2 files" });
  });

  it("has no checkbox when nothing is linked, and says one linked file in the singular", () => {
    expect(
      fileActionDialogCopy("delete", {
        requested: 1,
        linked: 0,
        includeLinked: true,
      }).linkedLabel
    ).toBeNull();
    expect(
      fileActionDialogCopy("delete", {
        requested: 1,
        linked: 1,
        includeLinked: true,
      })
    ).toMatchObject({
      linkedLabel: "Also delete 1 linked file",
      confirm: "Delete 2 files",
    });
  });

  it("mirrors the wording for a restore", () => {
    expect(
      fileActionDialogCopy("restore", {
        requested: 2,
        linked: 3,
        includeLinked: true,
      })
    ).toMatchObject({
      title: "Restore 2 files?",
      linkedLabel: "Also restore 3 linked files",
      confirm: "Restore 5 files",
    });
    expect(
      fileActionDialogCopy("restore", {
        requested: 1,
        linked: 0,
        includeLinked: true,
      }).title
    ).toBe("Restore file?");
  });
});

describe("linkedFilesHelp", () => {
  it("names the videos and preview images and the sidecar", () => {
    expect(linkedFilesHelp(["video", "preview_image", "sidecar"], 2)).toBe(
      "The videos and preview images made from these files, and the run.json saved with one of them."
    );
  });

  it("uses singular words for one selected file", () => {
    expect(linkedFilesHelp(["video", "preview_image", "sidecar"], 1)).toBe(
      "The videos and preview images made from this file, and the run.json saved with it."
    );
  });

  it("names only the kinds that are there", () => {
    expect(linkedFilesHelp(["sidecar"], 1)).toBe("The run.json saved with it.");
    expect(linkedFilesHelp(["video"], 3)).toBe(
      "The videos made from these files."
    );
    expect(linkedFilesHelp(["video", "preview_image", "output"], 2)).toBe(
      "The videos, preview images, and other files made from these files."
    );
  });

  it("names the raw file a restored output was made from", () => {
    expect(linkedFilesHelp(["made_from"], 1)).toBe(
      "The raw file this was made from."
    );
  });

  it("says nothing when nothing is linked", () => {
    expect(linkedFilesHelp([], 2)).toBe("");
  });
});
