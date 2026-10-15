// Browser-saved lists (recent runs, recent searches, and the like) are stored
// as a plain JSON array, which is what every earlier build wrote. Version 1 is
// that format, so a tab still running older code, or a rollback, reads what
// newer code saved instead of finding nothing and overwriting it. A later
// change to what a list holds can wrap it as `{ v, data }` with a higher `v`,
// and readers ignore a version they do not know.
export const STORAGE_FORMAT_VERSION = 1;

export function serializeVersioned(data: unknown): string {
  return JSON.stringify(data);
}

/**
 * Returns the saved data, or `undefined` when there is nothing usable: no value,
 * text that is not JSON, or a version this code does not know.
 */
export function parseVersioned(raw: string | null): unknown {
  if (!raw) {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "v" in parsed &&
    "data" in parsed
  ) {
    return parsed.v === STORAGE_FORMAT_VERSION ? parsed.data : undefined;
  }
  return;
}
