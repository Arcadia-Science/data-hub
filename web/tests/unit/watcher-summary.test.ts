import { describe, expect, it } from "vitest";
import {
  sharedComputerLine,
  versionSuffix,
  versionSuffixText,
} from "@/lib/watchers/summary";

describe("versionSuffix", () => {
  it("says up to date when the version equals the latest on the release form", () => {
    expect(versionSuffix("1.4.2", "1.4.2")).toEqual({ kind: "up_to_date" });
  });

  it("names the latest version when the watcher is older", () => {
    expect(versionSuffix("1.4.1", "1.4.2")).toEqual({
      kind: "update_available",
      latest: "1.4.2",
    });
    // Compared as versions, not as text.
    expect(versionSuffix("1.9.0", "1.10.0")).toEqual({
      kind: "update_available",
      latest: "1.10.0",
    });
  });

  it("says nothing when the release form has no latest version", () => {
    expect(versionSuffix("1.4.2", null)).toBeNull();
    expect(versionSuffix("1.4.2", "")).toBeNull();
    expect(versionSuffix("1.4.2", "  ")).toBeNull();
  });

  it("says nothing when the watcher reported no version", () => {
    expect(versionSuffix(null, "1.4.2")).toBeNull();
  });

  it("says nothing for a watcher that is newer than the release form", () => {
    expect(versionSuffix("1.5.0", "1.4.2")).toBeNull();
  });

  it("says nothing when a version can't be read, unless the two are the same text", () => {
    expect(versionSuffix("dev-build", "1.4.2")).toBeNull();
    expect(versionSuffix("dev-build", "dev-build")).toEqual({
      kind: "up_to_date",
    });
  });

  it("words each suffix as the copy deck does", () => {
    expect(versionSuffixText({ kind: "up_to_date" })).toBe("Up to date");
    expect(
      versionSuffixText({ kind: "update_available", latest: "1.4.2" })
    ).toBe("Update available: 1.4.2");
  });
});

const GEL_DOC = { instrumentId: "gel-doc", displayName: "Gel Doc" };
const SCANNER = { instrumentId: "scanner", displayName: "Scanner" };
const MIXER = { instrumentId: "mixer", displayName: "Mixer" };

// The page renders each instrument piece as a link; the copy is checked as
// the plain text those pieces add up to.
function sharedComputerText(
  others: Parameters<typeof sharedComputerLine>[0]
): string {
  return sharedComputerLine(others)
    .map((part) =>
      part.kind === "text" ? part.text : part.instrument.displayName
    )
    .join("");
}

describe("sharedComputerLine", () => {
  it("has no line when no other instrument shares the computer", () => {
    expect(sharedComputerLine([])).toEqual([]);
    expect(sharedComputerText([])).toBe("");
  });

  it("names one other instrument and says it affects both", () => {
    expect(sharedComputerText([SCANNER])).toBe(
      "This computer also runs the watcher for Scanner. Restarting it affects both instruments."
    );
  });

  it("lists two others and says it affects all of them", () => {
    expect(sharedComputerText([SCANNER, MIXER])).toBe(
      "This computer also runs the watchers for Scanner and Mixer. Restarting it affects all of them."
    );
  });

  it("lists every one of three or more others", () => {
    expect(sharedComputerText([GEL_DOC, SCANNER, MIXER])).toBe(
      "This computer also runs the watchers for Gel Doc, Scanner, and Mixer. Restarting it affects all of them."
    );
  });

  it("keeps each instrument as its own piece, so it can be a link", () => {
    const instruments = sharedComputerLine([SCANNER, MIXER]).flatMap((part) =>
      part.kind === "instrument" ? [part.instrument.instrumentId] : []
    );
    expect(instruments).toEqual(["scanner", "mixer"]);
  });
});
