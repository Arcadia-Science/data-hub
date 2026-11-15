// Runs a run-detection pattern from a watcher's config against one file path on
// the server. The pattern isn't checked against `settings.ts`, so it could be
// one that backtracks for a very long time. JavaScript can't interrupt a
// regular expression directly, but the `vm` timeout ends the whole call, so a
// pattern that runs too long counts as no match instead of hanging a request.

import { runInNewContext } from "node:vm";

/** `re.search(pattern, path).group(1)`, or null on a miss or empty group. */
function extractRunId(regex: RegExp, relativePath: string) {
  const match = regex.exec(relativePath);
  return match?.[1] ? match[1] : null;
}

/** Longest a single match may run. A sane pattern finishes in microseconds. */
export const RUN_ID_TIMEOUT_MS = 50;

/**
 * The run ID the watcher would give `relativePath`: group 1 of the pattern,
 * searched in the forward-slash path, like Python's `re.search`. Null when nothing
 * matches, the pattern doesn't compile, or the match runs past the timeout.
 */
export function runIdForPathGuarded(
  pattern: string,
  relativePath: string,
  timeoutMs: number = RUN_ID_TIMEOUT_MS
): string | null {
  const path = relativePath.replaceAll("\\", "/");
  try {
    const runId: unknown = runInNewContext(
      "match()",
      { match: () => extractRunId(new RegExp(pattern), path) },
      { timeout: timeoutMs }
    );
    return typeof runId === "string" ? runId : null;
  } catch {
    return null;
  }
}
