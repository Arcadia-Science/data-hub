// Reads the editable settings out of a watcher's pushed `config.yaml`. Kept
// apart from `settings.ts` so client components don't bundle the YAML parser.

import YAML from "yaml";
import {
  canonicalSettings,
  WATCHER_DEFAULTS,
  type WatcherConfigSettings,
  watcherConfigSettingsSchema,
} from "./settings";

export type YamlSettingsResult =
  | { ok: true; settings: WatcherConfigSettings }
  /** Why Data Hub can't use the file, for the Configuration tab. */
  | { ok: false; reason: string };

/**
 * Reads the editable settings out of a watcher's `config.yaml`, filling in
 * the watcher's defaults for missing keys. Fails with a short reason when
 * the YAML can't be parsed or the settings break the rules in `settings.ts`
 * (which can be stricter than an older watcher's own checks).
 */
export function readSettingsFromYaml(configYaml: string): YamlSettingsResult {
  let doc: unknown;
  try {
    doc = YAML.parse(configYaml);
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : "";
    return {
      ok: false,
      reason: detail
        ? `It isn't valid YAML: ${detail}`
        : "It isn't valid YAML.",
    };
  }
  const instrument = (doc as { instrument?: Record<string, unknown> } | null)
    ?.instrument;
  if (!instrument || typeof instrument !== "object") {
    return { ok: false, reason: "It has no instrument section." };
  }
  const runDetection = (instrument.run_detection ?? {}) as Record<
    string,
    unknown
  >;
  const candidate = {
    watch_directory: instrument.watch_directory,
    file_patterns: instrument.file_patterns,
    run_detection: {
      pattern: runDetection.pattern,
      recursive: runDetection.recursive ?? WATCHER_DEFAULTS.recursive,
    },
    upload_mode: instrument.upload_mode ?? WATCHER_DEFAULTS.upload_mode,
    stability_period_seconds:
      instrument.stability_period_seconds ??
      WATCHER_DEFAULTS.stability_period_seconds,
    max_stability_wait_seconds:
      instrument.max_stability_wait_seconds ??
      WATCHER_DEFAULTS.max_stability_wait_seconds,
    upload_parallelism:
      instrument.upload_parallelism ?? WATCHER_DEFAULTS.upload_parallelism,
  };
  const parsed = watcherConfigSettingsSchema.safeParse(candidate);
  if (parsed.success) {
    return { ok: true, settings: canonicalSettings(parsed.data) };
  }
  // Name each field by its key in the file, such as
  // `instrument.run_detection.pattern`, so it can be found and fixed there.
  const problems = parsed.error.issues.map(
    (issue) => `instrument.${issue.path.join(".")}: ${issue.message}`
  );
  return { ok: false, reason: problems.join("; ") };
}

/**
 * The editable settings from a watcher's `config.yaml`, or null when there
 * is none or it can't be used (see `readSettingsFromYaml` for why).
 */
export function parseSettingsFromYaml(
  configYaml: string | null
): WatcherConfigSettings | null {
  if (!configYaml) {
    return null;
  }
  const result = readSettingsFromYaml(configYaml);
  return result.ok ? result.settings : null;
}

export interface InstrumentConfigFields {
  /** In the order the config lists them, with no clean-up. */
  filePatterns: string[];
  uploadMode: "auto" | "manual";
  watchDirectory: string | null;
}

/**
 * The folder, file patterns and upload mode in a watcher's `config.yaml`, for
 * showing an instrument's state. Unlike `readSettingsFromYaml` it doesn't
 * check the values against the rules in `settings.ts`: a config the web app
 * can't edit still says which folder the watcher uses. Missing, unparseable
 * or oddly shaped YAML gives no folder, no patterns and the default mode.
 */
export function readInstrumentConfigFields(
  configYaml: string | null
): InstrumentConfigFields {
  const fields: InstrumentConfigFields = {
    watchDirectory: null,
    filePatterns: [],
    uploadMode: WATCHER_DEFAULTS.upload_mode,
  };
  if (!configYaml) {
    return fields;
  }
  let doc: unknown;
  try {
    doc = YAML.parse(configYaml);
  } catch {
    return fields;
  }
  const instrument = (
    doc as { instrument?: Record<string, unknown> | null } | null | undefined
  )?.instrument;
  const dir = instrument?.watch_directory;
  if (typeof dir === "string") {
    fields.watchDirectory = dir;
  }
  const patterns = instrument?.file_patterns;
  if (Array.isArray(patterns)) {
    fields.filePatterns = patterns.map(String);
  }
  if (instrument?.upload_mode === "manual") {
    fields.uploadMode = "manual";
  }
  return fields;
}

/**
 * The `instrument.watch_directory` of a watcher's `config.yaml`, or null when
 * the YAML is missing, unparseable or has none.
 */
export function extractWatchDirectory(
  configYaml: string | null
): string | null {
  return readInstrumentConfigFields(configYaml).watchDirectory;
}
