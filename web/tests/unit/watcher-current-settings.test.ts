import { describe, expect, it } from "vitest";
import {
  RUN_DETECTION_PRESETS,
  type WatcherConfigSettings,
} from "@/lib/api/watcher-config/settings";
import { currentSettingsRows } from "@/lib/watchers/current-settings";

const SETTINGS: WatcherConfigSettings = {
  watch_directory: "C:\\Data",
  file_patterns: ["*.tif", "*.jpg"],
  run_detection: {
    pattern: String.raw`^(?:.+/)?([^/]+?)\.[^/.]+$`,
    recursive: false,
  },
  upload_mode: "auto",
  stability_period_seconds: 5,
  max_stability_wait_seconds: 300,
  upload_parallelism: 4,
};

describe("currentSettingsRows", () => {
  it("has exactly the eight rows of the Current settings card, in order", () => {
    expect(currentSettingsRows(SETTINGS).map((row) => row.label)).toEqual([
      "Watch folder",
      "File patterns",
      "How files become runs",
      "Include subfolders",
      "Upload mode",
      "Stability period",
      "Max stability wait",
      "Parallel uploads",
    ]);
  });

  it("sets the folder in monospace and gives the patterns as a list", () => {
    const rows = currentSettingsRows(SETTINGS);
    expect(rows[0].value).toEqual({ kind: "mono", text: "C:\\Data" });
    expect(rows[1].value).toEqual({
      kind: "patterns",
      patterns: ["*.tif", "*.jpg"],
    });
  });

  it("names the preset a run pattern matches", () => {
    const stem = RUN_DETECTION_PRESETS.find((p) => p.key === "filename_stem");
    expect(currentSettingsRows(SETTINGS)[2].value).toEqual({
      kind: "text",
      text: stem?.label,
    });
  });

  it("shows a pattern that matches no preset as it is", () => {
    const rows = currentSettingsRows({
      ...SETTINGS,
      run_detection: { pattern: "^(RUN\\d+)", recursive: true },
    });
    expect(rows[2].value).toEqual({ kind: "mono", text: "^(RUN\\d+)" });
    expect(rows[3].value).toEqual({ kind: "text", text: "Yes" });
  });

  it("words the mode and the numbers", () => {
    const rows = currentSettingsRows({
      ...SETTINGS,
      upload_mode: "manual",
      stability_period_seconds: 1,
      max_stability_wait_seconds: 90,
      upload_parallelism: 8,
    });
    expect(rows.slice(4).map((row) => row.value)).toEqual([
      { kind: "text", text: "Manual" },
      { kind: "text", text: "1 second" },
      { kind: "text", text: "90 seconds" },
      { kind: "text", text: "8" },
    ]);
  });
});
