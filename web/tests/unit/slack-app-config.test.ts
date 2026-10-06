import { describe, expect, it } from "vitest";
import { resolveSlackSetting } from "@/lib/slack/app-config";

describe("resolveSlackSetting", () => {
  it("prefers a saved value over the environment variable", () => {
    expect(resolveSlackSetting("from-db", "from-env")).toEqual({
      value: "from-db",
      source: "database",
    });
  });

  it("uses the environment variable when nothing is saved", () => {
    expect(resolveSlackSetting(null, "from-env")).toEqual({
      value: "from-env",
      source: "environment",
    });
    expect(resolveSlackSetting("  ", "from-env")).toEqual({
      value: "from-env",
      source: "environment",
    });
  });

  it("is unset when neither source has a value", () => {
    expect(resolveSlackSetting(null, undefined)).toEqual({
      value: null,
      source: null,
    });
    expect(resolveSlackSetting(null, "  ")).toEqual({
      value: null,
      source: null,
    });
  });
});
