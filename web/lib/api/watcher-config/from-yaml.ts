// Reads the editable settings out of a watcher's pushed `config.yaml`. Kept
// apart from `settings.ts` so client components don't bundle the YAML parser.

import YAML from "yaml";
import {
  canonicalSettings,
  WATCHER_DEFAULTS,
  type WatcherConfigSettings,
  watcherConfigSettingsSchema,
} from "./settings";

/**
 * Reads the editable settings out of a watcher's `config.yaml`, filling in
 * the watcher's defaults for missing keys. Returns null when the YAML can't
 * be parsed or the settings fail the rules above.
 */
export function parseSettingsFromYaml(
  configYaml: string | null
): WatcherConfigSettings | null {
  if (!configYaml) {
    return null;
  }
  let doc: unknown;
  try {
    doc = YAML.parse(configYaml);
  } catch {
    return null;
  }
  const instrument = (doc as { instrument?: Record<string, unknown> } | null)
    ?.instrument;
  if (!instrument || typeof instrument !== "object") {
    return null;
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
  return parsed.success ? canonicalSettings(parsed.data) : null;
}
