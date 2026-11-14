// What an admin checks before confirming a pending instrument, and the rules
// the review dialog and its summary follow. No database imports, so the client
// components and the server read (lib/api/instrument-confirm-review.ts) share
// one definition.

import { RUN_DETECTION_PRESETS } from "@/lib/api/watcher-config/settings";
import type { InstrumentType } from "@/lib/db/schema";
import type { UploadMode } from "@/lib/instruments/connection";

/** The active watcher's settings, as the review shows them. */
export interface ConfirmReviewWatcher {
  filePatterns: string[];
  hostname: string | null;
  /** The run detection in the watcher's config. Null when the config has none. */
  runDetection: { pattern: string; recursive: boolean } | null;
  /** The token that registered the watcher. Null when none did, or it was revoked. */
  tokenName: string | null;
  uploadMode: UploadMode;
  watchDirectory: string | null;
}

/** What the Confirm review shows for one pending instrument. */
export interface InstrumentConfirmReview {
  displayName: string;
  instrumentId: string;
  /**
   * A recent file's path relative to the watch folder, for the worked example.
   * Null when the instrument has no files yet.
   */
  recentFilePath: string | null;
  /** The active watcher. Null when the instrument has none. */
  watcher: ConfirmReviewWatcher | null;
}

type PresetKey = (typeof RUN_DETECTION_PRESETS)[number]["key"];

// Plain names for the built-in run detection presets, as the review shows them.
const PLAIN_PRESET_NAMES: Record<PresetKey, string> = {
  filename_prefix: "Text before the first underscore",
  top_subdirectory: "Each top-level folder is a run",
  deepest_subdirectory: "The file's own folder is a run",
  timestamp_subdirectory:
    "Timestamp-named folder (YYYYMMDD_HHMMSS_fff) is a run",
  filename_stem: "Each file is its own run (file name without extension)",
};

// A sample path that each preset turns into a run, used when the instrument has
// no recent file that matches. A custom pattern uses the generic sample.
const SAMPLE_PATHS: Record<PresetKey, string> = {
  filename_prefix: "RUN001_quant.csv",
  top_subdirectory: "RUN001/quant.csv",
  deepest_subdirectory: "Exports/RUN001/quant.csv",
  timestamp_subdirectory: "20260314_101500_250/quant.csv",
  filename_stem: "RUN001_quant.csv",
};
const CUSTOM_SAMPLE_PATH = "RUN001_quant.csv";

function findPreset(pattern: string) {
  return (
    RUN_DETECTION_PRESETS.find((preset) => preset.pattern === pattern) ?? null
  );
}

/**
 * The plain name of a run detection pattern: the preset's name, or "Custom
 * pattern" when the pattern isn't one of the presets.
 */
export function runDetectionName(pattern: string): string {
  const preset = findPreset(pattern);
  return preset ? PLAIN_PRESET_NAMES[preset.key] : "Custom pattern";
}

/**
 * The run ID a watcher gives a file: the pattern's first capture group, searched
 * in the file's path relative to the watch folder, as the watcher matches it.
 * Null when nothing matches or the pattern doesn't compile.
 */
export function runIdForPath(pattern: string, path: string): string | null {
  let match: RegExpExecArray | null;
  try {
    match = new RegExp(pattern).exec(path);
  } catch {
    return null;
  }
  return match?.[1] || null;
}

export interface WorkedRunExample {
  /** The file path the example uses. */
  path: string;
  runId: string;
}

/**
 * One file and the run it lands in, to show what the detection does. Uses the
 * instrument's most recent file when the pattern matches it, and otherwise a
 * sample path. Null when neither matches.
 */
export function workedRunExample(
  pattern: string,
  recentFilePath: string | null
): WorkedRunExample | null {
  const preset = findPreset(pattern);
  const sample = preset ? SAMPLE_PATHS[preset.key] : CUSTOM_SAMPLE_PATH;
  for (const path of [recentFilePath, sample]) {
    if (!path) {
      continue;
    }
    const runId = runIdForPath(pattern, path);
    if (runId !== null) {
      return { path, runId };
    }
  }
  return null;
}

/**
 * The one request that confirms a pending instrument. It makes the instrument
 * active and saves the type the admin picked, in a single update.
 */
export function buildConfirmInstrumentBody(instrumentType: InstrumentType) {
  return { status: "active" as const, instrument_type: instrumentType };
}
