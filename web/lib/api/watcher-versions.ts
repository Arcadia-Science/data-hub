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

export const VERSION_REGEX = /^(\d+)\.(\d+)\.(\d+)([.-].+)?$/;

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
 * Returns `true` only when both `current` and `floor` are present, parse
 * cleanly, and `current < floor`. Any other input — null/undefined,
 * unparseable strings, or current ≥ floor — returns `false`.
 *
 * The fail-safe default is deliberate: enforcement on the heartbeat path
 * blocks watchers from checking in, so we'd rather miss an enforcement
 * (the next admin save can tighten it) than spuriously orphan a lab PC.
 * Mirrors the philosophy in `evaluate_update` on the watcher side, which
 * also refuses to act on un-parseable version strings.
 *
 * On equal X.Y.Z, an empty suffix (release) is treated as the highest
 * sort key — so `1.2.3` ≥ `1.2.3rc1`, matching PEP 440's release > pre
 * ordering. For two suffixed values we fall back to string compare,
 * which is conservative but enough for the rare pre-release floor case.
 */
export function isBelowFloor(
  current: string | null | undefined,
  floor: string | null | undefined
): boolean {
  if (!(current && floor)) {
    return false;
  }
  const a = parseLoose(current);
  const b = parseLoose(floor);
  if (!(a && b)) {
    return false;
  }
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) {
      return a.core[i] < b.core[i];
    }
  }
  if (a.suffix === b.suffix) {
    return false;
  }
  if (a.suffix === "") {
    return false;
  }
  if (b.suffix === "") {
    return true;
  }
  return a.suffix < b.suffix;
}
