// Previews a settings change against filenames the server already knows,
// using the same matching rules as the watcher. Glob patterns follow Python's
// `fnmatch.translate` (case-sensitive, matched against the file's own name),
// which `watcher/src/data_hub_watcher/monitor.py` compiles into one regex.
// Run IDs follow `re.search` on the forward-slash relative path, group 1.
//
// The server has only seen files that matched an older config, so files on
// the PC that never matched can't appear here.

import type { WatcherConfigSettings } from "./settings";

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\/]/g;

function escapeRegexChar(c: string): string {
  return c.replace(REGEX_SPECIALS, "\\$&");
}

// Port of the `[...]` branch of CPython's `fnmatch._translate`. Returns the
// regex piece and the index just past the closing `]`, or null when the `[`
// has no closing bracket (it then matches a literal `[`).
function translateBracket(
  pat: string,
  start: number
): { piece: string; next: number } | null {
  const n = pat.length;
  let j = start;
  if (j < n && pat[j] === "!") {
    j++;
  }
  if (j < n && pat[j] === "]") {
    j++;
  }
  while (j < n && pat[j] !== "]") {
    j++;
  }
  if (j >= n) {
    return null;
  }
  let i = start;
  let stuff: string;
  if (pat.slice(i, j).includes("-")) {
    const chunks: string[] = [];
    let k = pat[i] === "!" ? i + 2 : i + 1;
    while (true) {
      k = pat.indexOf("-", k);
      if (k < 0 || k >= j) {
        break;
      }
      chunks.push(pat.slice(i, k));
      i = k + 1;
      k += 3;
    }
    const chunk = pat.slice(i, j);
    if (chunk) {
      chunks.push(chunk);
    } else {
      chunks[chunks.length - 1] += "-";
    }
    // Drop empty ranges such as `z-a`, which are invalid in a regex.
    for (let m = chunks.length - 1; m > 0; m--) {
      const prev = chunks[m - 1];
      if (prev.slice(-1) > chunks[m][0]) {
        chunks[m - 1] = prev.slice(0, -1) + chunks[m].slice(1);
        chunks.splice(m, 1);
      }
    }
    stuff = chunks
      .map((s) => s.replaceAll("\\", "\\\\").replaceAll("-", "\\-"))
      .join("-");
  } else {
    stuff = pat.slice(i, j).replaceAll("\\", "\\\\");
  }
  stuff = stuff.replace(/([&~|])/g, "\\$1");
  const next = j + 1;
  if (!stuff) {
    return { piece: "(?!)", next };
  }
  if (stuff === "!") {
    return { piece: ".", next };
  }
  if (stuff[0] === "!") {
    stuff = `^${stuff.slice(1)}`;
  } else if (stuff[0] === "^" || stuff[0] === "[") {
    stuff = `\\${stuff}`;
  }
  // Python reads a leading `]` in a class as a literal; JavaScript reads
  // `[]` as an empty class, so escape it.
  stuff = stuff.replaceAll("]", "\\]");
  return { piece: `[${stuff}]`, next };
}

/** Translates one glob into an unanchored regex source, like fnmatch. */
export function translateGlob(pat: string): string {
  let out = "";
  let i = 0;
  let lastWasStar = false;
  while (i < pat.length) {
    const c = pat[i];
    i++;
    if (c === "*") {
      // Runs of `*` collapse into one.
      if (!lastWasStar) {
        out += ".*";
      }
      lastWasStar = true;
      continue;
    }
    lastWasStar = false;
    if (c === "?") {
      out += ".";
    } else if (c === "[") {
      const bracket = translateBracket(pat, i);
      if (bracket) {
        out += bracket.piece;
        i = bracket.next;
      } else {
        out += "\\[";
      }
    } else {
      out += escapeRegexChar(c);
    }
  }
  return out;
}

/**
 * Builds a `filename -> boolean` matcher for a list of globs, anchored at
 * both ends and case-sensitive like the watcher's monitor. `s` lets `.`
 * match newlines, as Python's `(?s:…)` wrapper does.
 */
export function compileFilePatternMatcher(
  patterns: readonly string[]
): (name: string) => boolean {
  if (patterns.length === 0) {
    return () => false;
  }
  const combined = patterns.map((p) => `(?:${translateGlob(p)})`).join("|");
  const regex = new RegExp(`^(?:${combined})$`, "s");
  return (name) => regex.test(name);
}

/** `re.search(pattern, path).group(1)`, or null on a miss or empty group. */
export function extractRunId(regex: RegExp, relativePath: string) {
  const match = regex.exec(relativePath);
  return match?.[1] ? match[1] : null;
}

export interface PreviewFile {
  matches: boolean;
  relative_path: string;
  run_id: string | null;
}

/**
 * Runs `settings` against relative paths (newest first). A file matches when
 * its name matches a pattern and, for a non-recursive watcher, it sits at the
 * top of the folder. Matching files get the run ID the watcher would derive;
 * files that don't match aren't detected, so they get no run ID.
 */
export function previewSettings(
  settings: Pick<WatcherConfigSettings, "file_patterns" | "run_detection">,
  relativePaths: readonly string[]
): PreviewFile[] {
  const matchesName = compileFilePatternMatcher(settings.file_patterns);
  const runRegex = new RegExp(settings.run_detection.pattern);
  return relativePaths.map((raw) => {
    const relativePath = raw.replaceAll("\\", "/");
    const name = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    const inScope =
      settings.run_detection.recursive || !relativePath.includes("/");
    const matches = inScope && matchesName(name);
    return {
      relative_path: relativePath,
      matches,
      run_id: matches ? extractRunId(runRegex, relativePath) : null,
    };
  });
}
