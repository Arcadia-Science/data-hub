import { describe, expect, it } from "vitest";
import {
  baseName,
  describeDuration,
  describeWithin,
  pluralize,
  sentenceCase,
} from "@/lib/watchers/phrases";

describe("sentenceCase", () => {
  it("writes snake_case as words", () => {
    expect(sentenceCase("some_new_type")).toBe("Some new type");
    expect(sentenceCase("update_succeeded")).toBe("Update succeeded");
  });

  it("writes kebab-case and camelCase as words", () => {
    expect(sentenceCase("env-switch")).toBe("Env switch");
    expect(sentenceCase("someNewKind")).toBe("Some new kind");
  });

  it("lowercases the rest", () => {
    expect(sentenceCase("RUN_REPORT_FAILED")).toBe("Run report failed");
  });

  it("has a word for nothing", () => {
    expect(sentenceCase("")).toBe("Event");
    expect(sentenceCase("__")).toBe("Event");
  });
});

describe("pluralize", () => {
  it("uses the singular for one", () => {
    expect(pluralize(1, "event")).toBe("1 event");
    expect(pluralize(0, "event")).toBe("0 events");
    expect(pluralize(2, "try", "tries")).toBe("2 tries");
    expect(pluralize(1, "try", "tries")).toBe("1 try");
  });
});

describe("baseName", () => {
  it("takes the last part of a Windows or POSIX path", () => {
    expect(baseName("D:\\Data\\run\\a.csv")).toBe("a.csv");
    expect(baseName("/data/run/a.csv")).toBe("a.csv");
    expect(baseName("a.csv")).toBe("a.csv");
  });
});

describe("describeDuration", () => {
  it("rounds up to the unit it is measured in", () => {
    expect(describeDuration(0)).toBe("0 seconds");
    expect(describeDuration(1)).toBe("1 second");
    expect(describeDuration(45)).toBe("45 seconds");
    expect(describeDuration(60)).toBe("1 minute");
    expect(describeDuration(61)).toBe("2 minutes");
    expect(describeDuration(3599)).toBe("1 hour");
    expect(describeDuration(3600)).toBe("1 hour");
    expect(describeDuration(7200)).toBe("2 hours");
    expect(describeDuration(86_400)).toBe("1 day");
    expect(describeDuration(3 * 86_400)).toBe("3 days");
  });
});

describe("describeWithin", () => {
  it("is a minute up to a minute", () => {
    expect(describeWithin(1)).toBe("a minute");
    expect(describeWithin(60)).toBe("a minute");
  });

  it("then says how long", () => {
    expect(describeWithin(61)).toBe("2 minutes");
    expect(describeWithin(3600)).toBe("an hour");
    expect(describeWithin(5400)).toBe("2 hours");
  });
});
