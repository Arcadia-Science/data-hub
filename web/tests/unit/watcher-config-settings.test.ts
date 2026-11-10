import { describe, expect, it } from "vitest";
import { parseSettingsFromYaml } from "@/lib/api/watcher-config/from-yaml";
import {
  checkRunDetectionPattern,
  describeSettingsChanges,
  RUN_DETECTION_PRESETS,
  settingsEqual,
  type WatcherConfigSettings,
  watcherConfigSettingsSchema,
} from "@/lib/api/watcher-config/settings";

const VALID: WatcherConfigSettings = {
  watch_directory: "D:\\Exports\\Plate",
  file_patterns: ["*.csv", "*.xlsx"],
  run_detection: { pattern: "^([^_]+)", recursive: false },
  upload_mode: "auto",
  stability_period_seconds: 5,
  max_stability_wait_seconds: 300,
  upload_parallelism: 4,
};

function issuesFor(patch: Record<string, unknown>) {
  const result = watcherConfigSettingsSchema.safeParse({ ...VALID, ...patch });
  return result.success
    ? []
    : result.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      }));
}

describe("checkRunDetectionPattern", () => {
  it.each([
    ["^([^_]+)", 1],
    ["(a)(b)", 2],
    ["(?:a)(b)", 1],
    ["a\\(b\\)", 0],
    ["[(]x", 0],
    ["(a(b))", 2],
    ["(?=x)(a)", 1],
    ["(?<=x)(a)", 1],
  ])("counts the capture groups in %j", (pattern, groups) => {
    const check = checkRunDetectionPattern(pattern);
    if (groups === 1) {
      expect(check).toEqual({ ok: true, groups: 1 });
    } else {
      expect(check).toEqual({
        ok: false,
        message: `Must have exactly 1 capture group, got ${groups}`,
      });
    }
  });

  it("rejects Python's named-group syntax, which JavaScript can't parse", () => {
    const pythonPattern = "^(?P<run>[^_]+)";
    const check = checkRunDetectionPattern(pythonPattern);
    expect(check.ok).toBe(false);
    expect(check.ok ? "" : check.message).toMatch(/Python-style named groups/);
    // JavaScript can't compile it either, so the check holds even without
    // the explicit message.
    expect(() => new RegExp(pythonPattern)).toThrow();
  });

  it("rejects JavaScript named groups, which the watcher can't parse", () => {
    const check = checkRunDetectionPattern("^(?<run>[^_]+)");
    expect(check.ok).toBe(false);
    expect(check.ok ? "" : check.message).toMatch(/Named groups/);
  });

  it("rejects a regex that doesn't compile, with a short reason", () => {
    expect(checkRunDetectionPattern("([a-")).toEqual({
      ok: false,
      message: expect.stringMatching(/^Invalid regular expression: (?!.*\/)/),
    });
    expect(checkRunDetectionPattern("").ok).toBe(false);
  });

  it("accepts every built-in preset", () => {
    for (const preset of RUN_DETECTION_PRESETS) {
      expect(checkRunDetectionPattern(preset.pattern), preset.key).toEqual({
        ok: true,
        groups: 1,
      });
    }
  });
});

describe("watcherConfigSettingsSchema", () => {
  it("accepts valid settings", () => {
    expect(issuesFor({})).toEqual([]);
  });

  it.each([
    "C:\\data",
    "c:/data",
    "\\\\server\\share\\plate",
    "/mnt/plate",
  ])("accepts the absolute path %j", (watch_directory) => {
    expect(issuesFor({ watch_directory })).toEqual([]);
  });

  it.each([
    "data",
    "./data",
    "C:data",
    "~/data",
    "",
  ])("rejects the non-absolute path %j", (watch_directory) => {
    expect(issuesFor({ watch_directory })[0]?.path).toBe("watch_directory");
  });

  it("caps the folder at 1024 characters", () => {
    expect(issuesFor({ watch_directory: `/${"a".repeat(1023)}` })).toEqual([]);
    expect(issuesFor({ watch_directory: `/${"a".repeat(1024)}` })).toHaveLength(
      1
    );
  });

  it("requires 1 to 50 non-blank patterns of up to 200 characters", () => {
    expect(issuesFor({ file_patterns: [] })[0]?.path).toBe("file_patterns");
    expect(issuesFor({ file_patterns: ["*.csv", "  "] })[0]?.path).toBe(
      "file_patterns.1"
    );
    expect(issuesFor({ file_patterns: [""] })[0]?.path).toBe("file_patterns.0");
    expect(issuesFor({ file_patterns: ["x".repeat(201)] })).toHaveLength(1);
    expect(issuesFor({ file_patterns: ["x".repeat(200)] })).toEqual([]);
    expect(
      issuesFor({ file_patterns: Array.from({ length: 51 }, () => "*.csv") })
    ).toHaveLength(1);
    expect(
      issuesFor({ file_patterns: Array.from({ length: 50 }, () => "*.csv") })
    ).toEqual([]);
  });

  it("checks the run-detection pattern", () => {
    expect(
      issuesFor({ run_detection: { pattern: "(a)(b)", recursive: true } })
    ).toEqual([
      {
        path: "run_detection.pattern",
        message: "Must have exactly 1 capture group, got 2",
      },
    ]);
    expect(
      issuesFor({
        run_detection: { pattern: "(?P<id>x)", recursive: true },
      })[0]?.path
    ).toBe("run_detection.pattern");
  });

  it("enforces the value ranges", () => {
    expect(issuesFor({ upload_mode: "sometimes" })).toHaveLength(1);
    expect(issuesFor({ stability_period_seconds: 0 })).toHaveLength(1);
    expect(issuesFor({ stability_period_seconds: 301 })).toHaveLength(2);
    expect(issuesFor({ stability_period_seconds: 2.5 })).toHaveLength(1);
    expect(issuesFor({ max_stability_wait_seconds: 86_401 })).toHaveLength(1);
    expect(issuesFor({ upload_parallelism: 0 })).toHaveLength(1);
    expect(issuesFor({ upload_parallelism: 33 })).toHaveLength(1);
    expect(issuesFor({ upload_parallelism: 32 })).toEqual([]);
  });

  it("requires the stability wait to cover the stability period", () => {
    expect(
      issuesFor({
        stability_period_seconds: 60,
        max_stability_wait_seconds: 59,
      })
    ).toEqual([
      {
        path: "max_stability_wait_seconds",
        message: "Must be at least the stability period",
      },
    ]);
    expect(
      issuesFor({
        stability_period_seconds: 60,
        max_stability_wait_seconds: 60,
      })
    ).toEqual([]);
  });
});

describe("settingsEqual", () => {
  it("ignores key order", () => {
    const reordered = {
      upload_parallelism: 4,
      max_stability_wait_seconds: 300,
      stability_period_seconds: 5,
      upload_mode: "auto",
      run_detection: { recursive: false, pattern: "^([^_]+)" },
      file_patterns: ["*.csv", "*.xlsx"],
      watch_directory: "D:\\Exports\\Plate",
    } as WatcherConfigSettings;
    expect(settingsEqual(VALID, reordered)).toBe(true);
  });

  it("treats pattern order as a change", () => {
    expect(
      settingsEqual(VALID, { ...VALID, file_patterns: ["*.xlsx", "*.csv"] })
    ).toBe(false);
  });
});

describe("parseSettingsFromYaml", () => {
  it("reads the instrument block and fills in the watcher's defaults", () => {
    const yaml = [
      "version: 1",
      "environment: staging",
      "instrument:",
      "  id: plate-reader",
      "  watch_directory: /data/plate",
      "  file_patterns: ['*.csv']",
      "  run_detection:",
      "    pattern: '^([^_]+)'",
    ].join("\n");
    expect(parseSettingsFromYaml(yaml)).toEqual({
      watch_directory: "/data/plate",
      file_patterns: ["*.csv"],
      run_detection: { pattern: "^([^_]+)", recursive: true },
      upload_mode: "auto",
      stability_period_seconds: 5,
      max_stability_wait_seconds: 300,
      upload_parallelism: 4,
    });
  });

  it("returns null for YAML it can't use", () => {
    expect(parseSettingsFromYaml(null)).toBeNull();
    expect(parseSettingsFromYaml("instrument: {}\n")).toBeNull();
    expect(parseSettingsFromYaml("instrument: [unclosed")).toBeNull();
    expect(parseSettingsFromYaml("just a string")).toBeNull();
  });
});

describe("describeSettingsChanges", () => {
  it("lists only the settings that changed", () => {
    expect(
      describeSettingsChanges(VALID, {
        ...VALID,
        file_patterns: ["*.csv"],
        upload_mode: "manual",
      })
    ).toEqual([
      {
        key: "file_patterns",
        label: "File patterns",
        from: "*.csv, *.xlsx",
        to: "*.csv",
      },
      {
        key: "upload_mode",
        label: "Upload mode",
        from: "Automatic",
        to: "Manual",
      },
    ]);
  });
});
