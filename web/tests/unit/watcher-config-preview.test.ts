import { describe, expect, it } from "vitest";
import {
  compileFilePatternMatcher,
  previewSettings,
} from "@/lib/api/watcher-config/preview";

const NAMES = [
  "data.csv",
  "DATA.CSV",
  "data_01.txt",
  "data_1.txt",
  "b1.xls",
  "a1.xls",
  "a.txt",
  "b.txt",
  "f9.dat",
  "f.dat",
  "-x",
  "bx",
  "dx",
  "run1",
  "runz1",
  "x.c",
  "x.h",
  "x.o",
  "abc",
  "aXbYc",
  "acb",
  "]x",
  "ax",
  "weird[.txt",
  "file.(1).csv",
  "line\nbreak.csv",
  "",
];

// Expected matches come from running Python's `fnmatch.translate` (the
// watcher's matcher) over NAMES, so these pin the port to the real thing.
const FNMATCH_CASES: [string, string[]][] = [
  ["*.csv", ["data.csv", "file.(1).csv", "line\nbreak.csv"]],
  ["*.CSV", ["DATA.CSV"]],
  ["data_??.txt", ["data_01.txt"]],
  ["[abc]*.xls", ["b1.xls", "a1.xls"]],
  ["[!a]*.txt", ["data_01.txt", "data_1.txt", "b.txt", "weird[.txt"]],
  ["*[0-9].dat", ["f9.dat"]],
  ["[a-c-]x", ["-x", "bx", "ax"]],
  ["run[z-a]1", []],
  ["*.[ch]", ["x.c", "x.h"]],
  ["a*b*c", ["abc", "aXbYc"]],
  ["[]]x", ["]x"]],
  ["[!]]x", ["-x", "bx", "dx", "ax"]],
  ["weird[.txt", ["weird[.txt"]],
  ["file.(1).csv", ["file.(1).csv"]],
  ["*", NAMES],
];

describe("compileFilePatternMatcher", () => {
  it.each(
    FNMATCH_CASES
  )("matches %j like Python's fnmatch", (pattern, expected) => {
    const matches = compileFilePatternMatcher([pattern]);
    expect(NAMES.filter(matches)).toEqual(expected);
  });

  it("is case-sensitive", () => {
    const matches = compileFilePatternMatcher(["*.csv"]);
    expect(matches("run.csv")).toBe(true);
    expect(matches("run.CSV")).toBe(false);
  });

  it("matches when any pattern matches", () => {
    const matches = compileFilePatternMatcher(["*.csv", "*.xlsx"]);
    expect(matches("a.xlsx")).toBe(true);
    expect(matches("a.txt")).toBe(false);
  });

  it("matches nothing with no patterns", () => {
    expect(compileFilePatternMatcher([])("a.csv")).toBe(false);
  });
});

describe("previewSettings", () => {
  const paths = [
    "PLATE1_read.csv",
    "PLATE1_notes.txt",
    "batch-7/PLATE2_read.csv",
    "batch-7/20260101_120000_000/scan.csv",
    "nounderscore.csv",
  ];

  it("matches the file name and takes group 1 of an unanchored search", () => {
    const result = previewSettings(
      {
        file_patterns: ["*.csv"],
        run_detection: { pattern: "([^_/]+)_read", recursive: true },
      },
      paths
    );
    expect(result).toEqual([
      { relative_path: "PLATE1_read.csv", matches: true, run_id: "PLATE1" },
      { relative_path: "PLATE1_notes.txt", matches: false, run_id: null },
      {
        relative_path: "batch-7/PLATE2_read.csv",
        matches: true,
        run_id: "PLATE2",
      },
      {
        relative_path: "batch-7/20260101_120000_000/scan.csv",
        matches: true,
        run_id: null,
      },
      { relative_path: "nounderscore.csv", matches: true, run_id: null },
    ]);
  });

  it("skips files in subfolders when the watcher isn't recursive", () => {
    const result = previewSettings(
      {
        file_patterns: ["*.csv"],
        run_detection: { pattern: "^([^_]+)", recursive: false },
      },
      paths
    );
    expect(result.filter((f) => f.matches).map((f) => f.relative_path)).toEqual(
      ["PLATE1_read.csv", "nounderscore.csv"]
    );
    expect(result[0].run_id).toBe("PLATE1");
    expect(result[2]).toMatchObject({ matches: false, run_id: null });
  });

  it("derives run IDs with the timestamp-folder preset", () => {
    const [file] = previewSettings(
      {
        file_patterns: ["*.csv"],
        run_detection: {
          pattern: String.raw`(?:^|/)(\d{8}_\d{6}_\d{3})/`,
          recursive: true,
        },
      },
      ["batch-7/20260101_120000_000/scan.csv"]
    );
    expect(file.run_id).toBe("20260101_120000_000");
  });

  it("normalizes backslash paths to forward slashes", () => {
    const [file] = previewSettings(
      {
        file_patterns: ["*.csv"],
        run_detection: { pattern: "^([^/]+)/", recursive: true },
      },
      ["run-1\\a.csv"]
    );
    expect(file).toEqual({
      relative_path: "run-1/a.csv",
      matches: true,
      run_id: "run-1",
    });
  });
});
