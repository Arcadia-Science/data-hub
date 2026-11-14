import { describe, expect, it } from "vitest";
import { patchInstrumentBody } from "@/lib/api/openapi";
import { RUN_DETECTION_PRESETS } from "@/lib/api/watcher-config/settings";
import { VALID_INSTRUMENT_TYPES } from "@/lib/db/schema";
import {
  buildConfirmInstrumentBody,
  runDetectionName,
  runIdForPath,
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

describe("runDetectionName", () => {
  it.each(PRESET_CASES)("names the %s preset in plain words", (key, name) => {
    expect(runDetectionName(presetPattern(key))).toBe(name);
  });

  it("calls a pattern that is not a preset a custom pattern", () => {
    expect(runDetectionName("^([A-Z]+)")).toBe("Custom pattern");
  });
});

describe("runIdForPath", () => {
  it("returns the pattern's first capture group", () => {
    expect(runIdForPath("^([^_]+)", "RUN001_quant.csv")).toBe("RUN001");
  });

  it("searches the path, so a folder in front of the run folder still matches", () => {
    expect(
      runIdForPath(
        presetPattern("timestamp_subdirectory"),
        "Archive/20260314_101500_250/quant.csv"
      )
    ).toBe("20260314_101500_250");
  });

  it("returns null for a file name the pattern does not match", () => {
    expect(
      runIdForPath(presetPattern("timestamp_subdirectory"), "quant.csv")
    ).toBeNull();
    expect(runIdForPath("^([^_]+)", "_quant.csv")).toBeNull();
  });

  it("returns null for a pattern that does not compile", () => {
    expect(runIdForPath("([", "RUN001_quant.csv")).toBeNull();
  });
});

describe("workedRunExample", () => {
  it.each(
    PRESET_CASES
  )("uses the %s preset's sample when there is no recent file", (key, _name, sample, runId) => {
    expect(workedRunExample(presetPattern(key), null)).toEqual({
      path: sample,
      runId,
    });
  });

  it("uses the most recent file when the pattern matches it", () => {
    expect(
      workedRunExample(presetPattern("filename_prefix"), "RUN777_fast.csv")
    ).toEqual({ path: "RUN777_fast.csv", runId: "RUN777" });
  });

  it("falls back to the sample when the recent file does not match", () => {
    expect(
      workedRunExample(presetPattern("timestamp_subdirectory"), "quant.csv")
    ).toEqual({
      path: "20260314_101500_250/quant.csv",
      runId: "20260314_101500_250",
    });
  });

  it("uses the generic sample for a custom pattern", () => {
    expect(workedRunExample("^([A-Z]+\\d+)", null)).toEqual({
      path: "RUN001_quant.csv",
      runId: "RUN001",
    });
  });

  it("gives no example when neither the recent file nor the sample matches", () => {
    expect(workedRunExample("^(NOPE\\d+)", "RUN001_quant.csv")).toBeNull();
  });
});
