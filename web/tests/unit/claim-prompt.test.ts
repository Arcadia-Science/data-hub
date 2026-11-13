import { describe, expect, it } from "vitest";
import {
  addDismissed,
  dismissalKey,
  MAX_DISMISSED_CLAIM_PROMPTS,
  mergeClaimPromptRuns,
  parseDismissed,
  selectRunsToPrompt,
} from "@/lib/runs/claim-prompt";
import { serializeVersioned } from "@/lib/versioned-storage";

const ALICE = "user-alice";
const BOB = "user-bob";

const UNCLAIMED = {
  instrumentId: "plate-reader",
  runId: "run-1",
  unclaimed: true,
};
const CLAIMED = {
  instrumentId: "plate-reader",
  runId: "run-2",
  unclaimed: false,
};
// Run IDs can hold characters that break naive string keys.
const ODD = { instrumentId: "scope a", runId: "50% #3 ?b", unclaimed: true };

describe("selectRunsToPrompt", () => {
  it("asks about unclaimed runs only", () => {
    expect(
      selectRunsToPrompt({
        candidates: [UNCLAIMED, CLAIMED],
        dismissed: [],
        userId: ALICE,
      })
    ).toEqual([{ instrumentId: "plate-reader", runId: "run-1" }]);
  });

  it("skips a run this person dismissed, but not one someone else dismissed", () => {
    const dismissed = addDismissed([], BOB, [UNCLAIMED]);
    expect(
      selectRunsToPrompt({ candidates: [UNCLAIMED], dismissed, userId: BOB })
    ).toEqual([]);
    expect(
      selectRunsToPrompt({ candidates: [UNCLAIMED], dismissed, userId: ALICE })
    ).toHaveLength(1);
  });

  it("asks about each run once", () => {
    expect(
      selectRunsToPrompt({
        candidates: [UNCLAIMED, { ...UNCLAIMED }, ODD],
        dismissed: [],
        userId: ALICE,
      })
    ).toEqual([
      { instrumentId: "plate-reader", runId: "run-1" },
      { instrumentId: "scope a", runId: "50% #3 ?b" },
    ]);
  });

  it("keeps runs whose IDs only differ by where a separator would fall apart", () => {
    const a = { instrumentId: "a:b", runId: "c", unclaimed: true };
    const b = { instrumentId: "a", runId: "b:c", unclaimed: true };
    expect(
      selectRunsToPrompt({ candidates: [a, b], dismissed: [], userId: ALICE })
    ).toHaveLength(2);
  });
});

describe("mergeClaimPromptRuns", () => {
  it("adds new runs after the ones already showing", () => {
    const current = [{ instrumentId: "plate-reader", runId: "run-1" }];
    expect(
      mergeClaimPromptRuns(current, [
        { instrumentId: "plate-reader", runId: "run-1" },
        { instrumentId: "plate-reader", runId: "run-3" },
      ])
    ).toEqual([
      { instrumentId: "plate-reader", runId: "run-1" },
      { instrumentId: "plate-reader", runId: "run-3" },
    ]);
  });
});

describe("dismissals in browser storage", () => {
  it("round-trips through versioned storage, including odd IDs", () => {
    const dismissed = addDismissed([], ALICE, [UNCLAIMED, ODD]);
    const restored = parseDismissed(serializeVersioned(dismissed));
    expect(restored).toEqual(dismissed);
    expect(
      selectRunsToPrompt({
        candidates: [UNCLAIMED, ODD],
        dismissed: restored,
        userId: ALICE,
      })
    ).toEqual([]);
  });

  it("reads nothing from missing, broken, or unknown-version values", () => {
    expect(parseDismissed(null)).toEqual([]);
    expect(parseDismissed("not json")).toEqual([]);
    expect(parseDismissed(JSON.stringify({ v: 99, data: ["x"] }))).toEqual([]);
    expect(parseDismissed(JSON.stringify(["ok", 3, null]))).toEqual(["ok"]);
  });

  it("moves a repeated dismissal to the newest end without duplicating it", () => {
    const first = addDismissed([], ALICE, [UNCLAIMED, ODD]);
    const again = addDismissed(first, ALICE, [UNCLAIMED]);
    expect(again).toEqual([
      dismissalKey(ALICE, ODD),
      dismissalKey(ALICE, UNCLAIMED),
    ]);
  });

  it("keeps only the newest dismissals", () => {
    const many = Array.from(
      { length: MAX_DISMISSED_CLAIM_PROMPTS + 5 },
      (_, i) => ({ instrumentId: "plate-reader", runId: `run-${i}` })
    );
    const dismissed = addDismissed([], ALICE, many);
    expect(dismissed).toHaveLength(MAX_DISMISSED_CLAIM_PROMPTS);
    expect(dismissed[0]).toBe(dismissalKey(ALICE, many[5]));
    expect(dismissed.at(-1)).toBe(dismissalKey(ALICE, many.at(-1) ?? many[0]));
  });
});
