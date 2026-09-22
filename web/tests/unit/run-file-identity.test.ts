import { describe, expect, it } from "vitest";
import {
  decideStoredNames,
  type IncomingRunFile,
  type StoredRunFile,
  taggedFilename,
} from "@/lib/api/run-file-identity";

function incoming(
  relativePath: string,
  overrides: Partial<IncomingRunFile> = {}
): IncomingRunFile {
  const filename = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  return {
    relativePath,
    filename,
    sizeBytes: 100,
    fileCreatedAt: new Date("2026-09-21T17:00:00.000Z"),
    ...overrides,
  };
}

function stored(
  id: number,
  relativePath: string,
  filename: string,
  overrides: Partial<StoredRunFile> = {}
): StoredRunFile {
  return {
    id,
    relativePath,
    filename,
    sizeBytes: 100,
    fileCreatedAt: new Date("2026-09-21T17:00:00.000Z"),
    ...overrides,
  };
}

describe("taggedFilename", () => {
  it("keeps the extension and depends only on the folder", () => {
    const folderA = "alice/day-1/capture-1/sample.tif";
    const folderB = "alice/day-2/capture-2/sample.tif";
    const taggedA = taggedFilename("sample.tif", folderA);
    expect(taggedA).toMatch(/^sample~[0-9a-f]{8}\.tif$/);
    expect(taggedFilename("sample.tif", folderA)).toBe(taggedA);
    expect(taggedFilename("sample.tif", folderB)).not.toBe(taggedA);
  });

  it("appends the suffix when there is no extension to preserve", () => {
    expect(taggedFilename("README", "notes/README")).toMatch(
      /^README~[0-9a-f]{8}$/
    );
    expect(taggedFilename(".gitignore", "pkg/.gitignore")).toMatch(
      /^\.gitignore~[0-9a-f]{8}$/
    );
  });

  it("renames a DishCam sidecar without hiding that it is run.json", () => {
    expect(taggedFilename("run.json", "alice/day-1/capture/run.json")).toMatch(
      /^run~[0-9a-f]{8}\.json$/
    );
  });
});

describe("decideStoredNames", () => {
  it("gives the first file the plain name and a later folder the hash", () => {
    const first = incoming("alice/day-1/capture-a/sample.tif");
    const second = incoming("alice/day-2/capture-b/sample.tif", {
      fileCreatedAt: new Date("2026-09-03T18:00:00.000Z"),
    });
    const [kept, renamed] = decideStoredNames(
      [second],
      [stored(1, first.relativePath, "sample.tif")]
    );
    expect(kept).toEqual({
      action: "insert",
      filename: taggedFilename("sample.tif", second.relativePath),
    });
    expect(renamed).toBeUndefined();
  });

  it("renames only the later file when both arrive in one batch", () => {
    const first = incoming("alice/day-1/capture-a/sample.tif");
    const second = incoming("alice/day-2/capture-b/sample.tif", {
      sizeBytes: 200,
    });
    const [plain, tagged] = decideStoredNames([first, second], []);
    expect(plain).toEqual({ action: "insert", filename: "sample.tif" });
    expect(tagged).toEqual({
      action: "insert",
      filename: taggedFilename("sample.tif", second.relativePath),
    });
  });

  it("reuses the stored row when name, size, and creation time match", () => {
    const copy = incoming("backup/sample.tif");
    const [decision] = decideStoredNames(
      [copy],
      [stored(7, "alice/day-1/capture-a/sample.tif", "sample.tif")]
    );
    expect(decision).toEqual({
      action: "existing",
      fileId: 7,
      filename: "sample.tif",
    });
  });

  it("keeps both files when size or creation time is missing", () => {
    const existing = stored(1, "a/sample.tif", "sample.tif");
    const noSize = incoming("b/sample.tif", { sizeBytes: null });
    const noTime = incoming("c/sample.tif", { fileCreatedAt: null });
    const [sized, timed] = decideStoredNames([noSize, noTime], [existing]);
    expect(sized).toEqual({
      action: "insert",
      filename: taggedFilename("sample.tif", noSize.relativePath),
    });
    expect(timed).toEqual({
      action: "insert",
      filename: taggedFilename("sample.tif", noTime.relativePath),
    });
  });

  it("treats creation times within a second as the same file", () => {
    const existing = stored(1, "a/sample.tif", "sample.tif", {
      fileCreatedAt: new Date("2026-09-21T17:00:00.000Z"),
    });
    const close = incoming("b/sample.tif", {
      fileCreatedAt: new Date("2026-09-21T17:00:00.999Z"),
    });
    const apart = incoming("c/sample.tif", {
      fileCreatedAt: new Date("2026-09-21T17:00:01.000Z"),
    });
    const [same, different] = decideStoredNames([close, apart], [existing]);
    expect(same).toMatchObject({ action: "existing", fileId: 1 });
    expect(different).toMatchObject({ action: "insert" });
  });

  it("returns the stored name on a re-report, including a tagged one", () => {
    const path = "alice/day-2/capture-b/sample.tif";
    const tagged = taggedFilename("sample.tif", path);
    const [decision] = decideStoredNames(
      [incoming(path, { fileCreatedAt: new Date("2026-09-03T18:00:00.000Z") })],
      [stored(4, path, tagged, { sizeBytes: 50 })]
    );
    expect(decision).toEqual({
      action: "existing",
      fileId: 4,
      filename: tagged,
    });
  });
});
