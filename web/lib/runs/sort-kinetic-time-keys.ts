/**
 * SoftMax Pro kinetic elapsed times are `HH:MM:SS` within the first day and
 * `D.HH:MM:SS` once the run crosses midnight. Lexicographic / numeric string
 * sorts interleave day prefixes with hour digits (e.g. `03:00:39` after
 * `2.02:11:12`), so we parse to total seconds before ordering.
 */
function parseElapsedTimeToSeconds(label: string): number | null {
  const withDays = label.match(
    /^(\d+)\.(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/
  );
  if (withDays) {
    const days = Number(withDays[1]);
    const hours = Number(withDays[2]);
    const minutes = Number(withDays[3]);
    const seconds = Number(withDays[4]);
    const frac = withDays[5] ? Number(`0.${withDays[5]}`) : 0;
    return days * 86_400 + hours * 3600 + minutes * 60 + seconds + frac;
  }

  const hms = label.match(/^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (hms) {
    const hours = Number(hms[1]);
    const minutes = Number(hms[2]);
    const seconds = Number(hms[3]);
    const frac = hms[4] ? Number(`0.${hms[4]}`) : 0;
    return hours * 3600 + minutes * 60 + seconds + frac;
  }

  return null;
}

/**
 * Sort time-point keys so kinetic slider frames appear in chronological order.
 * Prefers numeric timestamps (scan indices / seconds), then SoftMax elapsed
 * durations, then locale-aware natural sort as a last resort.
 */
export function sortTimeKeys(keys: string[]): string[] {
  const unique = [...new Set(keys)];
  const allNumeric = unique.every((k) => {
    if (k === "") {
      return false;
    }
    return Number.isFinite(Number(k));
  });
  if (allNumeric) {
    return unique.sort((a, b) => Number(a) - Number(b));
  }

  const parsed = new Map<string, number>();
  let allElapsed = true;
  for (const k of unique) {
    const seconds = parseElapsedTimeToSeconds(k);
    if (seconds === null) {
      allElapsed = false;
      break;
    }
    parsed.set(k, seconds);
  }
  if (allElapsed) {
    return unique.sort((a, b) => (parsed.get(a) ?? 0) - (parsed.get(b) ?? 0));
  }

  return unique.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
}
