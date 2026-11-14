import { parseVersioned, serializeVersioned } from "@/lib/versioned-storage";

// After a download from a run nobody has claimed, the web app asks whether the
// person ran it. "Not me" is remembered in this browser, per person and run,
// so the same run never asks again.

export const CLAIM_PROMPT_DISMISSED_KEY = "data-hub:claim-prompt-dismissed";

// Oldest dismissals drop off first. A person who dismissed this many runs has
// seen the prompt often enough that one more ask for an old run is harmless.
export const MAX_DISMISSED_CLAIM_PROMPTS = 1000;

export interface ClaimPromptRun {
  instrumentId: string;
  runId: string;
}

export interface ClaimPromptCandidate extends ClaimPromptRun {
  // True when nobody has claimed the run.
  unclaimed: boolean;
}

// JSON keeps IDs that contain `%`, `#`, `?`, or spaces apart.
export function runKey(run: ClaimPromptRun): string {
  return JSON.stringify([run.instrumentId, run.runId]);
}

export function dismissalKey(userId: string, run: ClaimPromptRun): string {
  return JSON.stringify([userId, run.instrumentId, run.runId]);
}

/**
 * The runs to ask about: unclaimed, not dismissed by this person, each once.
 */
export function selectRunsToPrompt({
  candidates,
  dismissed,
  userId,
}: {
  candidates: readonly ClaimPromptCandidate[];
  dismissed: readonly string[];
  userId: string;
}): ClaimPromptRun[] {
  const dismissedKeys = new Set(dismissed);
  const seen = new Set<string>();
  const runs: ClaimPromptRun[] = [];
  for (const candidate of candidates) {
    const key = runKey(candidate);
    if (!candidate.unclaimed || seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (dismissedKeys.has(dismissalKey(userId, candidate))) {
      continue;
    }
    runs.push({ instrumentId: candidate.instrumentId, runId: candidate.runId });
  }
  return runs;
}

/** Adds runs to a prompt that is already showing, keeping each run once. */
export function mergeClaimPromptRuns(
  current: readonly ClaimPromptRun[],
  incoming: readonly ClaimPromptRun[]
): ClaimPromptRun[] {
  const seen = new Set(current.map(runKey));
  const merged = [...current];
  for (const run of incoming) {
    const key = runKey(run);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(run);
    }
  }
  return merged;
}

/** Records dismissals newest last, keeping at most the newest 1,000. */
export function addDismissed(
  dismissed: readonly string[],
  userId: string,
  runs: readonly ClaimPromptRun[]
): string[] {
  const added = [...new Set(runs.map((run) => dismissalKey(userId, run)))];
  const addedKeys = new Set(added);
  const kept = dismissed.filter((key) => !addedKeys.has(key));
  return [...kept, ...added].slice(-MAX_DISMISSED_CLAIM_PROMPTS);
}

export function parseDismissed(raw: string | null): string[] {
  const parsed = parseVersioned(raw);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((key): key is string => typeof key === "string");
}

export function readDismissedClaimPrompts(): string[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    return parseDismissed(localStorage.getItem(CLAIM_PROMPT_DISMISSED_KEY));
  } catch {
    return [];
  }
}

export function writeDismissedClaimPrompts(dismissed: readonly string[]) {
  try {
    localStorage.setItem(
      CLAIM_PROMPT_DISMISSED_KEY,
      serializeVersioned(dismissed)
    );
  } catch {
    // Private browsing or a full disk. The run may ask once more later.
  }
}
