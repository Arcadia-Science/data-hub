// The rows of the Settings tab's "Current settings" card, in the words the card
// uses. `settingsDisplayRows` serves the change history and the edit form's
// diff, with their own labels, so this is a separate list. No database
// imports.

import {
  RUN_DETECTION_PRESETS,
  type WatcherConfigSettings,
} from "@/lib/api/watcher-config/settings";

export type CurrentSettingValue =
  /** A path or other literal, set in the monospace face. */
  | { kind: "mono"; text: string }
  | { kind: "patterns"; patterns: string[] }
  | { kind: "text"; text: string };

export interface CurrentSettingRow {
  key:
    | "watch_directory"
    | "file_patterns"
    | "run_detection"
    | "recursive"
    | "upload_mode"
    | "stability_period"
    | "max_stability_wait"
    | "upload_parallelism";
  label: string;
  value: CurrentSettingValue;
}

function seconds(count: number): string {
  return `${count} ${count === 1 ? "second" : "seconds"}`;
}

/**
 * What the watcher is running, as eight label and value rows: Watch folder,
 * File patterns, How files become runs, Include subfolders, Upload mode,
 * Stability period, Max stability wait and Parallel uploads. How files become
 * runs shows the name of the preset whose pattern the watcher uses, or the
 * pattern itself when it matches none.
 */
export function currentSettingsRows(
  settings: WatcherConfigSettings
): CurrentSettingRow[] {
  const preset = RUN_DETECTION_PRESETS.find(
    (p) => p.pattern === settings.run_detection.pattern
  );
  return [
    {
      key: "watch_directory",
      label: "Watch folder",
      value: { kind: "mono", text: settings.watch_directory },
    },
    {
      key: "file_patterns",
      label: "File patterns",
      value: { kind: "patterns", patterns: settings.file_patterns },
    },
    {
      key: "run_detection",
      label: "How files become runs",
      value: preset
        ? { kind: "text", text: preset.label }
        : { kind: "mono", text: settings.run_detection.pattern },
    },
    {
      key: "recursive",
      label: "Include subfolders",
      value: {
        kind: "text",
        text: settings.run_detection.recursive ? "Yes" : "No",
      },
    },
    {
      key: "upload_mode",
      label: "Upload mode",
      value: {
        kind: "text",
        text: settings.upload_mode === "auto" ? "Automatic" : "Manual",
      },
    },
    {
      key: "stability_period",
      label: "Stability period",
      value: { kind: "text", text: seconds(settings.stability_period_seconds) },
    },
    {
      key: "max_stability_wait",
      label: "Max stability wait",
      value: {
        kind: "text",
        text: seconds(settings.max_stability_wait_seconds),
      },
    },
    {
      key: "upload_parallelism",
      label: "Parallel uploads",
      value: { kind: "text", text: String(settings.upload_parallelism) },
    },
  ];
}
