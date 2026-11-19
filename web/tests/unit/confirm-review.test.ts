import { describe, expect, it } from "vitest";
import { patchInstrumentBody } from "@/lib/api/openapi";
import { runIdForPathGuarded } from "@/lib/api/watcher-config/guarded-run-id";
import { RUN_DETECTION_PRESETS } from "@/lib/api/watcher-config/settings";
import { VALID_INSTRUMENT_TYPES } from "@/lib/db/schema";
import {
  buildConfirmInstrumentBody,
  presetRunDetectionName,
  workedRunExample,
} from "@/lib/instruments/confirm-review";

type PresetKey = (typeof RUN_DETECTION_PRESETS)[number]["key"];

function presetPattern(key: PresetKey): string {
  const preset = RUN_DETECTION_PRESETS.find((p) => p.key === key);
  if (!preset) {
    throw new Error(`No run detection preset named ${key}`);
  }
  return preset.pattern;
}

// Each preset's plain name, and the sample path and run ID the review shows
// when the instrument has no recent file that matches.
const PRESET_CASES: [PresetKey, string, string, string][] = [
  [
    "filename_prefix",
    "Text before the first underscore",
    "RUN001_quant.csv",
    "RUN001",
  ],
  [
    "top_subdirectory",
    "Each top-level folder is a run",
    "RUN001/quant.csv",
    "RUN001",
  ],
  [
    "deepest_subdirectory",
    "The file's own folder is a run",
    "Exports/RUN001/quant.csv",
    "RUN001",
  ],
  [
    "timestamp_subdirectory",
    "Timestamp-named folder (YYYYMMDD_HHMMSS_fff) is a run",
    "20260314_101500_250/quant.csv",
    "20260314_101500_250",
  ],
  [
    "filename_stem",
    "Each file is its own run (file name without extension)",
    "RUN001_quant.csv",
    "RUN001_quant",
  ],
];

describe("buildConfirmInstrumentBody", () => {
  it("activates the instrument and saves its type in one body", () => {
    expect(buildConfirmInstrumentBody("qpcr")).toEqual({
      status: "active",
      instrument_type: "qpcr",
    });
  });

  it.each(
    VALID_INSTRUMENT_TYPES
  )("is a body the PATCH route accepts for the %s type", (type) => {
    expect(patchInstrumentBody.parse(buildConfirmInstrumentBody(type))).toEqual(
      { status: "active", instrument_type: type }
    );
  });
});

describe("presetRunDetectionName", () => {
  it.each(PRESET_CASES)("names the %s preset in plain words", (key, name) => {
    expect(presetRunDetectionName(presetPattern(key))).toBe(name);
  });

  it("gives no name to a pattern that is not a preset", () => {
    expect(presetRunDetectionName("^([A-Z]+)")).toBeNull();
  });
});

describe("runIdForPathGuarded", () => {
  it("returns the pattern's first capture group", () => {
    expect(runIdForPathGuarded("^([^_]+)", "RUN001_quant.csv")).toBe("RUN001");
  });

  it("searches the path, so a folder in front of the run folder still matches", () => {
    expect(
      runIdForPathGuarded(
        presetPattern("timestamp_subdirectory"),
        "Archive/20260314_101500_250/quant.csv"
      )
    ).toBe("20260314_101500_250");
  });

  it("reads a Windows path with backslashes the way the watcher does", () => {
    expect(
      runIdForPathGuarded(
        presetPattern("top_subdirectory"),
        "RUN001\\quant.csv"
      )
    ).toBe("RUN001");
  });

  it("returns null for a file name the pattern does not match", () => {
    expect(
      runIdForPathGuarded(presetPattern("timestamp_subdirectory"), "quant.csv")
    ).toBeNull();
    expect(runIdForPathGuarded("^([^_]+)", "_quant.csv")).toBeNull();
  });

  it("returns null for a pattern that does not compile", () => {
    expect(runIdForPathGuarded("([", "RUN001_quant.csv")).toBeNull();
  });

  it("gives up on a pattern that backtracks for too long", () => {
    const started = performance.now();
    const runId = runIdForPathGuarded("^(a+)+$", `${"a".repeat(40)}!`, 25);
    expect(runId).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("workedRunExample", () => {
  it.each(
    PRESET_CASES
  )("uses the %s preset's sample when there is no recent file", (key, _name, sample, runId) => {
    expect(
      workedRunExample(presetPattern(key), null, runIdForPathGuarded)
    ).toEqual({ path: sample, runId });
  });

  it("uses the most recent file when the pattern matches it", () => {
    expect(
      workedRunExample(
        presetPattern("filename_prefix"),
        "RUN777_fast.csv",
        runIdForPathGuarded
      )
    ).toEqual({ path: "RUN777_fast.csv", runId: "RUN777" });
  });

  it("falls back to the sample when the recent file does not match", () => {
    expect(
      workedRunExample(
        presetPattern("timestamp_subdirectory"),
        "quant.csv",
        runIdForPathGuarded
      )
    ).toEqual({
      path: "20260314_101500_250/quant.csv",
      runId: "20260314_101500_250",
    });
  });

  it("uses the generic sample for a custom pattern", () => {
    expect(
      workedRunExample("^([A-Z]+\\d+)", null, runIdForPathGuarded)
    ).toEqual({ path: "RUN001_quant.csv", runId: "RUN001" });
  });

  it("gives no example when neither the recent file nor the sample matches", () => {
    expect(
      workedRunExample("^(NOPE\\d+)", "RUN001_quant.csv", runIdForPathGuarded)
    ).toBeNull();
  });

  it("asks the matcher it is given, not a built-in one", () => {
    expect(
      workedRunExample("any", "a/b.csv", (_pattern, path) =>
        path === "a/b.csv" ? "from-matcher" : null
      )
    ).toEqual({ path: "a/b.csv", runId: "from-matcher" });
  });
});
