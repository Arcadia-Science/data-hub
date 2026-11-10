// The watcher settings an admin can edit from the web app, and the rules they
// must pass. The watcher checks the same rules in Pydantic
// (`watcher/src/data_hub_watcher/models.py`), so keep the two in step. This
// module is plain Zod with no database or OpenAPI imports, so the edit form,
// the MCP tools and unit tests can all load it.

import { z } from "zod";

export const WATCH_DIRECTORY_MAX_LENGTH = 1024;
export const FILE_PATTERNS_MAX = 50;
export const FILE_PATTERN_MAX_LENGTH = 200;
export const STABILITY_PERIOD_RANGE = { min: 1, max: 300 } as const;
export const MAX_STABILITY_WAIT_RANGE = { min: 1, max: 86_400 } as const;
export const UPLOAD_PARALLELISM_RANGE = { min: 1, max: 32 } as const;

// Defaults the watcher applies when a key is missing from `config.yaml`.
export const WATCHER_DEFAULTS = {
  upload_mode: "auto",
  stability_period_seconds: 5,
  max_stability_wait_seconds: 300,
  upload_parallelism: 4,
  recursive: true,
} as const;

// Copied from `RUN_DETECTION_PRESETS` in
// `watcher/src/data_hub_watcher/constants.py`. Each is valid in both Python
// and JavaScript and has exactly one capture group.
export const RUN_DETECTION_PRESETS = [
  {
    key: "filename_prefix",
    label: "Filename prefix (before the first underscore)",
    pattern: "^([^_]+)",
    recursive: false,
  },
  {
    key: "top_subdirectory",
    label: "Each top-level folder is a run",
    pattern: "^([^/]+)/",
    recursive: true,
  },
  {
    key: "deepest_subdirectory",
    label: "The file's own folder is a run",
    pattern: "([^/]+)/[^/]+$",
    recursive: true,
  },
  {
    key: "timestamp_subdirectory",
    label: "Timestamp-named folder (YYYYMMDD_HHMMSS_fff) is a run",
    pattern: String.raw`(?:^|/)(\d{8}_\d{6}_\d{3})/`,
    recursive: true,
  },
  {
    key: "filename_stem",
    label: "Each file is its own run (filename without extension)",
    pattern: String.raw`^(?:.+/)?([^/]+?)\.[^/.]+$`,
    recursive: false,
  },
] as const;

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const UNC_PATH = /^\\\\/;
const POSIX_PATH = /^\//;

export function isAbsoluteWatchPath(path: string): boolean {
  return (
    WINDOWS_DRIVE_PATH.test(path) ||
    UNC_PATH.test(path) ||
    POSIX_PATH.test(path)
  );
}

// Python writes named groups as `(?P<name>…)`, which JavaScript can't parse.
// JavaScript writes them as `(?<name>…)`, which Python can't parse, so the
// watcher would reject it. Lookbehinds (`(?<=`, `(?<!`) are fine in both.
const JS_NAMED_GROUP = /\(\?<(?![=!])/;

export type RegexCheck =
  | { ok: true; groups: number }
  | { ok: false; message: string };

/**
 * Compiles a run-detection pattern the way the server can and counts its
 * capture groups. Appending `|` makes the regex match the empty string, so
 * the result array always exists and its length is the group count plus one.
 */
export function checkRunDetectionPattern(pattern: string): RegexCheck {
  if (pattern.length === 0) {
    return { ok: false, message: "Enter a regular expression" };
  }
  if (pattern.includes("(?P<") || pattern.includes("(?P=")) {
    return {
      ok: false,
      message:
        "Python-style named groups, such as (?P<name>…), aren't supported. Use a plain capture group, such as (…)",
    };
  }
  if (JS_NAMED_GROUP.test(pattern)) {
    return {
      ok: false,
      message:
        "Named groups aren't supported. Use a plain capture group, such as (…)",
    };
  }
  let match: RegExpExecArray | null;
  try {
    match = new RegExp(`${pattern}|`).exec("");
  } catch (err) {
    // Engines prefix the message with the whole regex; keep only the reason.
    const raw = err instanceof Error ? err.message : String(err);
    const detail = raw.replace(
      /^Invalid regular expression: \/[\s\S]*\/[a-z]*: /,
      ""
    );
    return { ok: false, message: `Invalid regular expression: ${detail}` };
  }
  const groups = match ? match.length - 1 : 0;
  if (groups !== 1) {
    return {
      ok: false,
      message: `Must have exactly 1 capture group, got ${groups}`,
    };
  }
  return { ok: true, groups };
}

const intInRange = (range: { min: number; max: number }) =>
  z.number().int().min(range.min).max(range.max);

export const watcherConfigSettingsSchema = z
  .object({
    watch_directory: z
      .string()
      .min(1, "Enter a folder")
      .max(WATCH_DIRECTORY_MAX_LENGTH)
      .refine(isAbsoluteWatchPath, {
        message:
          "Must be an absolute path, such as D:\\Exports, \\\\server\\share or /data",
      }),
    file_patterns: z
      .array(
        z
          .string()
          .max(FILE_PATTERN_MAX_LENGTH)
          .refine((p) => p.trim().length > 0, {
            message: "Patterns can't be blank",
          })
      )
      .min(1, "Add at least one file pattern")
      .max(FILE_PATTERNS_MAX),
    run_detection: z.object({
      pattern: z.string().superRefine((pattern, ctx) => {
        const check = checkRunDetectionPattern(pattern);
        if (!check.ok) {
          ctx.addIssue({ code: "custom", message: check.message });
        }
      }),
      recursive: z.boolean(),
    }),
    upload_mode: z.enum(["auto", "manual"]),
    stability_period_seconds: intInRange(STABILITY_PERIOD_RANGE),
    max_stability_wait_seconds: intInRange(MAX_STABILITY_WAIT_RANGE),
    upload_parallelism: intInRange(UPLOAD_PARALLELISM_RANGE),
  })
  .superRefine((settings, ctx) => {
    if (
      settings.max_stability_wait_seconds < settings.stability_period_seconds
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["max_stability_wait_seconds"],
        message: "Must be at least the stability period",
      });
    }
  });

export type WatcherConfigSettings = z.infer<typeof watcherConfigSettingsSchema>;

// Fixed key order, so two equal settings objects serialize identically no
// matter how they were built.
export function canonicalSettings(
  settings: WatcherConfigSettings
): WatcherConfigSettings {
  return {
    watch_directory: settings.watch_directory,
    file_patterns: [...settings.file_patterns],
    run_detection: {
      pattern: settings.run_detection.pattern,
      recursive: settings.run_detection.recursive,
    },
    upload_mode: settings.upload_mode,
    stability_period_seconds: settings.stability_period_seconds,
    max_stability_wait_seconds: settings.max_stability_wait_seconds,
    upload_parallelism: settings.upload_parallelism,
  };
}

export function settingsEqual(
  a: WatcherConfigSettings,
  b: WatcherConfigSettings
): boolean {
  return (
    JSON.stringify(canonicalSettings(a)) ===
    JSON.stringify(canonicalSettings(b))
  );
}

/**
 * Reads stored revision JSON back into settings. Rows are validated before
 * they're written, but the rules may tighten later, so an old row that no
 * longer passes is returned as stored rather than throwing.
 */
export function settingsFromStored(value: unknown): WatcherConfigSettings {
  const parsed = watcherConfigSettingsSchema.safeParse(value);
  return parsed.success
    ? canonicalSettings(parsed.data)
    : (value as WatcherConfigSettings);
}

export const SETTING_LABELS = {
  watch_directory: "Watch folder",
  file_patterns: "File patterns",
  run_detection_pattern: "Run detection pattern",
  run_detection_recursive: "Include subfolders",
  upload_mode: "Upload mode",
  stability_period_seconds: "Stability period (seconds)",
  max_stability_wait_seconds: "Max stability wait (seconds)",
  upload_parallelism: "Parallel uploads",
} as const;

export type SettingKey = keyof typeof SETTING_LABELS;

/** Each setting as display text, in form order. */
export function settingsDisplayRows(
  settings: WatcherConfigSettings
): { key: SettingKey; label: string; value: string }[] {
  const values: Record<SettingKey, string> = {
    watch_directory: settings.watch_directory,
    file_patterns: settings.file_patterns.join(", "),
    run_detection_pattern: settings.run_detection.pattern,
    run_detection_recursive: settings.run_detection.recursive ? "Yes" : "No",
    upload_mode: settings.upload_mode === "auto" ? "Automatic" : "Manual",
    stability_period_seconds: String(settings.stability_period_seconds),
    max_stability_wait_seconds: String(settings.max_stability_wait_seconds),
    upload_parallelism: String(settings.upload_parallelism),
  };
  return (Object.keys(SETTING_LABELS) as SettingKey[]).map((key) => ({
    key,
    label: SETTING_LABELS[key],
    value: values[key],
  }));
}

/** The settings that differ between two revisions, as display text. */
export function describeSettingsChanges(
  before: WatcherConfigSettings,
  after: WatcherConfigSettings
): { key: SettingKey; label: string; from: string; to: string }[] {
  const beforeRows = settingsDisplayRows(before);
  const afterRows = settingsDisplayRows(after);
  return afterRows.flatMap((row, i) => {
    const from = beforeRows[i].value;
    return from === row.value
      ? []
      : [{ key: row.key, label: row.label, from, to: row.value }];
  });
}
