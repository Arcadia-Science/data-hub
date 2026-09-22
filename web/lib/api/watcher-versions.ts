// Loose PEP 440-ish version match / ordering. Shared by the admin
// watcher-release PUT route, the settings form, and heartbeat floor
// checks so a typo is rejected with the same rule everywhere.
//
// Covers the values we advertise (`9.9.9`, `0.1.0`) plus common
// `1.2.3rc1` / `1.2.3.post1` shapes. We intentionally don't validate
// against PyPI on write; a typo surfaces as an `update_failed` event
// from the fleet — the same failure mode operators already debug.
//
// Real PEP 440 ordering would mean either a dependency or ~200 lines of
// spec code; the shapes we actually use all fit this simpler model.

// A suffix may start with "." or "-" (`1.2.3.post1`, `1.2.3-rc1`) or run
// straight into the numbers (`1.2.3rc1`). The form already tells operators
// that the second shape is valid.
export const VERSION_REGEX = /^(\d+)\.(\d+)\.(\d+)([.-].+|[a-zA-Z].*)?$/;

export const VERSION_MESSAGE =
  "Use a PEP 440-style version like 1.2.3 or 1.2.3rc1.";

interface ParsedVersion {
  core: [number, number, number];
  // Anything after the X.Y.Z prefix, including the leading "." / "-".
  // Empty string ⇒ release; non-empty ⇒ pre-release / post-release suffix.
  suffix: string;
}

function parseLoose(v: string): ParsedVersion | null {
  const m = VERSION_REGEX.exec(v.trim());
  if (!m) {
    return null;
  }
  return {
    core: [Number(m[1]), Number(m[2]), Number(m[3])],
    suffix: m[4] ?? "",
  };
}

/**
 * Orders two PEP 440-ish versions. Returns -1 when `a` is older, 1 when
 * `a` is newer, 0 when they match, and `null` when either string can't
 * be parsed.
 *
 * On equal X.Y.Z, an empty suffix (a release) sorts above any suffix, so
 * `1.2.3` > `1.2.3rc1`. Two suffixed values fall back to string compare,
 * which is enough for the rare pre-release case.
 */
export function compareVersions(
  a: string | null | undefined,
  b: string | null | undefined
): -1 | 0 | 1 | null {
  if (!(a && b)) {
    return null;
  }
  const left = parseLoose(a);
  const right = parseLoose(b);
  if (!(left && right)) {
    return null;
  }
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) {
      return left.core[i] < right.core[i] ? -1 : 1;
    }
  }
  if (left.suffix === right.suffix) {
    return 0;
  }
  if (left.suffix === "") {
    return 1;
  }
  if (right.suffix === "") {
    return -1;
  }
  return left.suffix < right.suffix ? -1 : 1;
}

/**
 * Returns `true` only when both `current` and `floor` are present, parse
 * cleanly, and `current < floor`. Any other input — null/undefined,
 * unparseable strings, or current ≥ floor — returns `false`.
 *
 * The fail-safe default is deliberate: enforcement on the heartbeat path
 * blocks watchers from checking in, so we'd rather miss an enforcement
 * (the next admin save can tighten it) than spuriously orphan a lab PC.
 * Mirrors the philosophy in `evaluate_update` on the watcher side, which
 * also refuses to act on un-parseable version strings.
 */
export function isBelowFloor(
  current: string | null | undefined,
  floor: string | null | undefined
): boolean {
  return compareVersions(current, floor) === -1;
}

/**
 * Returns `true` only when `current` parses and is at least `min`.
 *
 * Missing or unreadable versions return `false`, the opposite of
 * `isBelowFloor`. Feature gates fall back to the older behavior rather
 * than turning a new behavior on for a watcher we can't identify.
 */
export function isAtLeast(
  current: string | null | undefined,
  min: string
): boolean {
  const order = compareVersions(current, min);
  return order !== null && order >= 0;
}
