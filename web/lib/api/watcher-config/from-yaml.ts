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
