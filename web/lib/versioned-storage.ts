// Browser-saved lists (recent runs, recent searches, and the like) are wrapped
// as `{ v, data }`. A later change to what a list holds can then bump `v`, and
// old readers and new readers each ignore a format they do not understand
// instead of misreading it.
export const STORAGE_FORMAT_VERSION = 1;

export function serializeVersioned(data: unknown): string {
  return JSON.stringify({ v: STORAGE_FORMAT_VERSION, data });
}

/**
 * Returns the saved data, or `undefined` when there is nothing usable: no value,
 * text that is not JSON, or a version this code does not know. A list saved
 * before versions existed is a bare array, and it is still read.
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
