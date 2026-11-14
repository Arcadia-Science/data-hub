// The words on a watcher page's summary strip that depend on more than one
// value. No database imports, so server pages and client components share them.

import { compareVersions } from "@/lib/api/watcher-versions";
import type { SharedComputerInstrument } from "@/lib/instruments/connection";

export type VersionSuffix =
  | { kind: "up_to_date" }
  | { kind: "update_available"; latest: string };

/**
 * What follows the watcher's version, compared with the latest version on the
 * release form: "Up to date" when they are equal, "Update available: {latest}"
 * when the watcher is older, and nothing when the release form has no latest
 * version, the watcher reported none, or it runs a newer one than the form
 * names (a test build, say, which isn't news to anyone).
 */
export function versionSuffix(
  version: string | null,
  latestVersion: string | null
): VersionSuffix | null {
  const latest = latestVersion?.trim();
  if (!(version && latest)) {
    return null;
  }
  if (version.trim() === latest) {
    return { kind: "up_to_date" };
  }
  const order = compareVersions(version, latest);
  if (order === 0) {
    return { kind: "up_to_date" };
  }
  return order === -1 ? { kind: "update_available", latest } : null;
}

export function versionSuffixText(suffix: VersionSuffix): string {
  return suffix.kind === "up_to_date"
    ? "Up to date"
    : `Update available: ${suffix.latest}`;
}

/**
 * A piece of the shared-computer line: plain words, or a linked instrument.
 * `key` is stable and unique within the line, for a React list.
 */
export type SharedComputerPart =
  | { kind: "text"; key: string; text: string }
  | {
      kind: "instrument";
      key: string;
      instrument: SharedComputerInstrument;
    };

/**
 * The line that says other instruments' watchers run on this computer, as
 * pieces so that each instrument can be a link:
 *
 * - One other: "This computer also runs the watcher for {A}. Restarting it
 *   affects both instruments."
 * - Two or more: "This computer also runs the watchers for {A} and {B}.
 *   Restarting it affects all of them." Three or more list every one, as in
 *   "{A}, {B}, and {C}".
 *
 * Returns an empty list when nothing else shares the computer.
 */
export function sharedComputerLine(
  others: readonly SharedComputerInstrument[]
): SharedComputerPart[] {
  if (others.length === 0) {
    return [];
  }
  const list = new Intl.ListFormat("en", {
    style: "long",
    type: "conjunction",
  }).formatToParts(others.map((_, index) => String(index)));

  const parts: SharedComputerPart[] = [
    {
      kind: "text",
      key: "lead",
      text: `This computer also runs the ${others.length === 1 ? "watcher" : "watchers"} for `,
    },
  ];
  list.forEach((part, index) => {
    const instrument =
      part.type === "element" ? others[Number(part.value)] : undefined;
    parts.push(
      instrument
        ? {
            kind: "instrument",
            key: `instrument-${instrument.instrumentId}`,
            instrument,
          }
        : { kind: "text", key: `separator-${index}`, text: part.value }
    );
  });
  parts.push({
    kind: "text",
    key: "tail",
    text: `. Restarting it affects ${others.length === 1 ? "both instruments" : "all of them"}.`,
  });
  return parts;
}

/** The shared-computer line as plain text. */
export function sharedComputerText(
  others: readonly SharedComputerInstrument[]
): string {
  return sharedComputerLine(others)
    .map((part) =>
      part.kind === "text" ? part.text : part.instrument.displayName
    )
    .join("");
}
