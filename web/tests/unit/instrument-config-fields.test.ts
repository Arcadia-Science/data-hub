import { describe, expect, it } from "vitest";
import { readInstrumentConfigFields } from "@/lib/api/watcher-config/from-yaml";

function config(runDetectionLines: string[]): string {
  return [
    "instrument:",
    "  watch_directory: 'D:\\Exports'",
    ...runDetectionLines,
  ].join("\n");
}

describe("readInstrumentConfigFields run detection", () => {
  it("reads the pattern", () => {
    const fields = readInstrumentConfigFields(
      config([
        "  run_detection:",
        "    pattern: '^([^_]+)'",
        "    recursive: true",
      ])
    );
    expect(fields.runDetection).toEqual({ pattern: "^([^_]+)" });
  });

  it("reads the pattern when recursive is missing", () => {
    const fields = readInstrumentConfigFields(
      config(["  run_detection:", "    pattern: '^([^_]+)'"])
    );
    expect(fields.runDetection).toEqual({ pattern: "^([^_]+)" });
  });

  it.each([
    ["a string instead of a mapping", ["  run_detection: '^([^_]+)'"]],
    ["a list instead of a mapping", ["  run_detection:", "    - '^([^_]+)'"]],
    ["an empty value", ["  run_detection:"]],
    ["a pattern that is not a string", ["  run_detection:", "    pattern: 12"]],
    ["a mapping with no pattern", ["  run_detection:", "    recursive: true"]],
  ])("gives no run detection for %s", (_label, lines) => {
    expect(readInstrumentConfigFields(config(lines)).runDetection).toBeNull();
  });

  it("gives no run detection for a missing or unreadable config", () => {
    expect(readInstrumentConfigFields(null).runDetection).toBeNull();
    expect(readInstrumentConfigFields("instrument: [").runDetection).toBeNull();
  });

  it("still reads the other fields when the run detection is odd", () => {
    expect(
      readInstrumentConfigFields(config(["  run_detection: 3"]))
    ).toMatchObject({ watchDirectory: "D:\\Exports", runDetection: null });
  });
});
