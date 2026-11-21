import { describe, expect, it } from "vitest";
import {
  folderOfPath,
  isSidecarFilename,
  linkedFileLabel,
  linkedFilesOf,
  outputRelation,
} from "@/lib/runs/file-links";

interface Candidate {
  category: "raw" | "processed";
  contentType: string | null;
  deletedAt: Date | null;
  filename: string;
  id: number;
  relativePath: string | null;
  sourceFileId: number | null;
}

function raw(
  id: number,
  filename: string,
  folder: string,
  overrides: Partial<Candidate> = {}
): Candidate {
  return {
    id,
    filename,
    relativePath: `${folder}/${filename}`,
    category: "raw",
    contentType: null,
    sourceFileId: null,
    deletedAt: null,
    ...overrides,
  };
}

function made(
  id: number,
  filename: string,
  sourceFileId: number | null,
  overrides: Partial<Candidate> = {}
): Candidate {
  return {
    id,
    filename,
    relativePath: null,
    category: "processed",
    contentType: null,
    sourceFileId,
    deletedAt: null,
    ...overrides,
  };
}

// Two captures in different folders, as in a DishCam run, and the one raw
// file's outputs deleted.
const deletedAt = new Date("2026-11-19T10:42:00Z");
const files: Candidate[] = [
  raw(1, "s001_A.tif", "cap_one"),
  raw(2, "run.json", "cap_one"),
  made(3, "s001_A.jpg", 1),
  made(4, "s001_A.mp4", 1),
  raw(5, "s001_A_1.tif", "cap_two"),
  raw(6, "run~0a1b2c3d.json", "cap_two", { deletedAt }),
  made(7, "s001_A_1.mp4", 5, { deletedAt }),
  made(8, "s001_A_1.jpg", 5, { deletedAt }),
  made(9, "s001_A_1_colonies.csv", 5),
];

function linksOf(id: number) {
  const file = files.find((candidate) => candidate.id === id);
  if (!file) {
    throw new Error(`no file ${id}`);
  }
  return linkedFilesOf(file, files).map((link) => [
    link.file.filename,
    link.relation,
  ]);
}

describe("linkedFilesOf", () => {
  it("lists what a raw file made, then the sidecar of its folder", () => {
    expect(linksOf(1)).toEqual([
      ["s001_A.mp4", "video"],
      ["s001_A.jpg", "preview_image"],
      ["run.json", "sidecar"],
    ]);
  });

  it("lists deleted links too, so the window can mark them", () => {
    expect(linksOf(5)).toEqual([
      ["s001_A_1.mp4", "video"],
      ["s001_A_1.jpg", "preview_image"],
      ["s001_A_1_colonies.csv", "output"],
      ["run~0a1b2c3d.json", "sidecar"],
    ]);
  });

  it("leaves out the sidecar of another folder", () => {
    expect(linksOf(1).map(([name]) => name)).not.toContain("run~0a1b2c3d.json");
  });

  it("links a processed file back to the raw file it was made from", () => {
    expect(linksOf(4)).toEqual([["s001_A.tif", "made_from"]]);
  });

  it("has no links for a processed file with no source", () => {
    const orphan = made(20, "old.png", null);
    expect(linkedFilesOf(orphan, [...files, orphan])).toEqual([]);
  });

  it("has no links for a sidecar", () => {
    expect(linksOf(2)).toEqual([]);
  });

  it("reads a file with no stored path as being in the watch folder", () => {
    const loose = raw(30, "loose.tif", "", { relativePath: null });
    const sidecar = raw(31, "run.json", "", { relativePath: null });
    expect(
      linkedFilesOf(loose, [loose, sidecar, ...files]).map((link) => [
        link.file.filename,
        link.relation,
      ])
    ).toEqual([["run.json", "sidecar"]]);
  });
});

describe("isSidecarFilename", () => {
  it.each([
    ["run.json", true],
    ["RUN.JSON", true],
    ["run~0a1b2c3d.json", true],
    ["run~0a1b2c3d4e5f6a7b.json", true],
    ["run~0a1b.json", false],
    ["runs.json", false],
    ["myrun.json", false],
    ["run.json.bak", false],
  ])("%s -> %s", (name, expected) => {
    expect(isSidecarFilename(name)).toBe(expected);
  });
});

describe("outputRelation", () => {
  it("tells a video, a preview image, and another output apart", () => {
    expect(outputRelation({ filename: "a.mp4", contentType: null })).toBe(
      "video"
    );
    expect(
      outputRelation({ filename: "a.bin", contentType: "video/mp4" })
    ).toBe("video");
    expect(outputRelation({ filename: "a.JPG", contentType: null })).toBe(
      "preview_image"
    );
    expect(outputRelation({ filename: "a.csv", contentType: "text/csv" })).toBe(
      "output"
    );
  });
});

describe("folderOfPath", () => {
  it("cuts the file name off, and gives no folder to a bare name", () => {
    expect(folderOfPath("a/b/c.tif")).toBe("a/b");
    expect(folderOfPath("c.tif")).toBe("");
  });
});

describe("linkedFileLabel", () => {
  it("says how each linked file relates to the open one", () => {
    expect(linkedFileLabel("video", false)).toEqual({
      lead: null,
      trail: "Video made from this file",
    });
    expect(linkedFileLabel("preview_image", false).trail).toBe(
      "Preview image made from this file"
    );
    expect(linkedFileLabel("sidecar", false).trail).toBe(
      "Saved with this capture"
    );
    expect(linkedFileLabel("made_from", false)).toEqual({
      lead: "Made from",
      trail: "",
    });
  });

  it("marks a deleted link", () => {
    expect(linkedFileLabel("video", true).trail).toBe(
      "Video made from this file · Deleted"
    );
    expect(linkedFileLabel("sidecar", true).trail).toBe(
      "Saved with this capture · Deleted"
    );
    expect(linkedFileLabel("made_from", true)).toEqual({
      lead: "Made from",
      trail: " · Deleted",
    });
  });
});
