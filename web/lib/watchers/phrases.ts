// Small wording helpers for the watcher page's Activity and Health tabs. No
// database imports, so server pages and client components share them.

/** "1 file", "2 files". */
export function pluralize(count: number, one: string, many?: string): string {
  return `${count} ${count === 1 ? one : (many ?? `${one}s`)}`;
}

/**
 * Writes an event type or a `details.kind` as a sentence-case label, so a name
 * the code doesn't know yet still reads as words: `some_new_type` becomes "Some
 * new type". Never returns a snake_case name.
 */
export function sentenceCase(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .toLowerCase();
  if (!words) {
    return "Event";
  }
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The last part of a Windows or POSIX path. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;

/**
 * A length of time in words, rounded up to the unit it is measured in: "45
 * seconds", "1 minute", "4 minutes", "2 hours", "3 days".
 */
export function describeDuration(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  if (total < SECONDS_PER_MINUTE) {
    return pluralize(total, "second");
  }
  const minutes = Math.ceil(total / SECONDS_PER_MINUTE);
  if (minutes < MINUTES_PER_HOUR) {
    return pluralize(minutes, "minute");
  }
  const hours = Math.ceil(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) {
    return pluralize(hours, "hour");
  }
  return pluralize(Math.ceil(hours / HOURS_PER_DAY), "day");
}

/**
 * The "within ..." of a recovery: "a minute" up to a minute, then "4
 * minutes", "an hour", "2 hours".
 */
export function describeWithin(seconds: number): string {
  if (seconds <= SECONDS_PER_MINUTE) {
    return "a minute";
  }
  const phrase = describeDuration(seconds);
  return phrase === "1 hour" ? "an hour" : phrase;
}
