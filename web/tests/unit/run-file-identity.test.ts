import { describe, expect, it } from "vitest";
import {
  type DismissedRunFile,
  decideStoredNames,
  type IncomingRunFile,
  isSameAsDismissed,
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
    ...overrides,
  };
}

function dismissed(
  relativePath: string,
  overrides: Partial<DismissedRunFile> = {}
): DismissedRunFile {
  return {
    relativePath,
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
    const [decision] = decideStoredNames(
      [second],
      [stored(1, first.relativePath, "sample.tif")]
    );
    expect(decision).toEqual({
      action: "insert",
      filename: taggedFilename("sample.tif", second.relativePath),
    });
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

  it("keeps both files when name, size, and creation time match", () => {
    const copy = incoming("backup/sample.tif");
    const [decision] = decideStoredNames(
      [copy],
      [stored(7, "alice/day-1/capture-a/sample.tif", "sample.tif")]
    );
    expect(decision).toEqual({
      action: "insert",
      filename: taggedFilename("sample.tif", copy.relativePath),
    });
  });

  it("returns the stored name on a re-report, including a tagged one", () => {
    const path = "alice/day-2/capture-b/sample.tif";
    const tagged = taggedFilename("sample.tif", path);
    const [decision] = decideStoredNames(
      [incoming(path, { fileCreatedAt: new Date("2026-09-03T18:00:00.000Z") })],
      [stored(4, path, tagged)]
    );
    expect(decision).toEqual({
      action: "existing",
      fileId: 4,
      filename: tagged,
    });
  });
});

describe("isSameAsDismissed", () => {
  const file = { sizeBytes: 100, fileCreatedAt: new Date("2026-09-21T17:00Z") };

  it("is the same file when the size and creation time both match", () => {
    expect(isSameAsDismissed(file, { ...file })).toBe(true);
  });

  it("is a different file when the size differs", () => {
    expect(isSameAsDismissed(file, { ...file, sizeBytes: 101 })).toBe(false);
  });

  it("is a different file when the creation time differs", () => {
    expect(
      isSameAsDismissed(file, {
        ...file,
        fileCreatedAt: new Date("2026-09-21T17:00:01Z"),
      })
    ).toBe(false);
  });

  it("compares creation times as the stored value comes back", () => {
    // The watcher reports microseconds. `new Date` keeps the first three
    // digits, so the stored value and the new report agree.
    const stored = new Date("2026-09-21T17:00:00.123456+00:00");
    const reported = new Date("2026-09-21T17:00:00.123999+00:00");
    expect(stored.getTime()).toBe(reported.getTime());
    expect(
      isSameAsDismissed(
        { sizeBytes: 5, fileCreatedAt: reported },
        { sizeBytes: 5, fileCreatedAt: stored }
      )
    ).toBe(true);
    expect(
      isSameAsDismissed(
        { sizeBytes: 5, fileCreatedAt: new Date("2026-09-21T17:00:00.124Z") },
        { sizeBytes: 5, fileCreatedAt: stored }
      )
    ).toBe(false);
  });

  it("compares only the values both sides have", () => {
    const noTime = { ...file, fileCreatedAt: null };
    // A row from before creation times were stored: the size decides.
    expect(isSameAsDismissed(file, noTime)).toBe(true);
    expect(isSameAsDismissed(file, { ...noTime, sizeBytes: 7 })).toBe(false);
    // A report without a size: the creation time decides.
    const noSize = { ...file, sizeBytes: null };
    expect(isSameAsDismissed(noSize, { ...file })).toBe(true);
    expect(
      isSameAsDismissed(noSize, {
        ...file,
        fileCreatedAt: new Date("2026-09-22T17:00Z"),
      })
    ).toBe(false);
    // Nothing to compare: stays dismissed, as it did before.
    expect(
      isSameAsDismissed(
        { sizeBytes: null, fileCreatedAt: null },
        { sizeBytes: null, fileCreatedAt: null }
      )
    ).toBe(true);
    expect(
      isSameAsDismissed({ sizeBytes: null, fileCreatedAt: null }, { ...file })
    ).toBe(true);
  });
});

describe("decideStoredNames with dismissed files", () => {
  const path = "alice/day-1/capture-a/sample.tif";

  it("inserts a different file at a dismissed path under the plain name", () => {
    const [decision] = decideStoredNames(
      [incoming(path, { sizeBytes: 250 })],
      [],
      [dismissed(path)]
    );
    expect(decision).toEqual({ action: "insert", filename: "sample.tif" });
  });

  it("inserts a file with a newer creation time at a dismissed path", () => {
    const [decision] = decideStoredNames(
      [incoming(path, { fileCreatedAt: new Date("2026-09-22T09:00:00.000Z") })],
      [],
      [dismissed(path)]
    );
    expect(decision).toEqual({ action: "insert", filename: "sample.tif" });
  });

  it("skips the same file reported again", () => {
    const [decision] = decideStoredNames(
      [incoming(path)],
      [],
      [dismissed(path)]
    );
    expect(decision).toEqual({ action: "dismissed" });
  });

  it("skips a file that matches any of several dismissed rows at the path", () => {
    const rows = [
      dismissed(path, { sizeBytes: 10 }),
      dismissed(path, { sizeBytes: 20 }),
      dismissed(path, { sizeBytes: 30 }),
    ];
    expect(
      decideStoredNames([incoming(path, { sizeBytes: 20 })], [], rows)
    ).toEqual([{ action: "dismissed" }]);
    expect(
      decideStoredNames([incoming(path, { sizeBytes: 40 })], [], rows)
    ).toEqual([{ action: "insert", filename: "sample.tif" }]);
  });

  it("ignores a dismissed row at another path", () => {
    const [decision] = decideStoredNames(
      [incoming(path)],
      [],
      [dismissed("alice/day-2/capture-b/sample.tif")]
    );
    expect(decision).toEqual({ action: "insert", filename: "sample.tif" });
  });

  it("maps to the active row at a path before it looks at dismissed ones", () => {
    const [decision] = decideStoredNames(
      [incoming(path, { sizeBytes: 250 })],
      [stored(9, path, "sample.tif")],
      [dismissed(path, { sizeBytes: 250 })]
    );
    expect(decision).toEqual({
      action: "existing",
      fileId: 9,
      filename: "sample.tif",
    });
  });

  it("tags a new file at a dismissed path when another folder has the plain name", () => {
    const other = "alice/day-2/capture-b/sample.tif";
    const [decision] = decideStoredNames(
      [incoming(path, { sizeBytes: 250 })],
      [stored(3, other, "sample.tif")],
      [dismissed(path)]
    );
    expect(decision).toEqual({
      action: "insert",
      filename: taggedFilename("sample.tif", path),
    });
  });

  it("lets a skipped file leave the plain name to the next file in the batch", () => {
    const later = "alice/day-2/capture-b/sample.tif";
    const decisions = decideStoredNames(
      [incoming(path), incoming(later, { sizeBytes: 11 })],
      [],
      [dismissed(path)]
    );
    expect(decisions).toEqual([
      { action: "dismissed" },
      { action: "insert", filename: "sample.tif" },
    ]);
  });

  it("gives a new file and a different file at a dismissed path their own names", () => {
    const later = "alice/day-2/capture-b/sample.tif";
    const decisions = decideStoredNames(
      [incoming(path, { sizeBytes: 250 }), incoming(later, { sizeBytes: 11 })],
      [],
      [dismissed(path)]
    );
    expect(decisions).toEqual([
      { action: "insert", filename: "sample.tif" },
      { action: "insert", filename: taggedFilename("sample.tif", later) },
    ]);
  });
});
