"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import { trackClientEvent } from "@/lib/analytics/track-client";
import { fanOutAttribution } from "@/lib/runs/attribution-requests";
import {
  addDismissed,
  type ClaimPromptCandidate,
  type ClaimPromptRun,
  mergeClaimPromptRuns,
  readDismissedClaimPrompts,
  runKey,
  selectRunsToPrompt,
  writeDismissedClaimPrompts,
} from "@/lib/runs/claim-prompt";

import { ClaimPromptCard } from "./claim-prompt-card";

export interface ClaimPromptActions {
  ask: (candidates: readonly ClaimPromptCandidate[]) => void;
}

export const ClaimPromptContext = createContext<ClaimPromptActions | null>(
  null
);

// After a download from a run nobody has claimed, asks whether the person ran
// it. The card lives in the app shell, so it stays up while they move between
// pages and goes away on reload. It is not a toast: an open dialog (the file
// preview, the archive progress) would block clicks on a toast, and a click
// outside the archive dialog closes it and drops its downloads. Dialogs cover
// this card instead, and it works again once they close.
export function ClaimPromptProvider({
  children,
  userId,
}: {
  children: ReactNode;
  userId: string;
}) {
  const router = useRouter();
  const [runs, setRuns] = useState<ClaimPromptRun[]>([]);
  // Mirrors `runs` so `ask` can tell which runs are new without waiting for
  // a render.
  const runsRef = useRef<ClaimPromptRun[]>([]);
  const [isPending, startTransition] = useTransition();

  const showRuns = useCallback((next: ClaimPromptRun[]) => {
    runsRef.current = next;
    setRuns(next);
  }, []);

  const ask = useCallback(
    (candidates: readonly ClaimPromptCandidate[]) => {
      const toAsk = selectRunsToPrompt({
        candidates,
        dismissed: readDismissedClaimPrompts(),
        userId,
      });
      const current = runsRef.current;
      const merged = mergeClaimPromptRuns(current, toAsk);
      const added = merged.length - current.length;
      if (added === 0) {
        return;
      }
      showRuns(merged);
      trackClientEvent("claim_prompt_shown", { runs: added });
    },
    [showRuns, userId]
  );

  function claim() {
    const target = runsRef.current;
    trackClientEvent("claim_prompt_answered", {
      answer: "claimed",
      runs: target.length,
    });
    startTransition(async () => {
      const { ok, failed, failedRuns } = await fanOutAttribution("PUT", target);
      // Runs added while the requests were in flight stay on the card.
      const claimed = new Set(
        target.filter((run) => !failedRuns.includes(run)).map(runKey)
      );
      showRuns(runsRef.current.filter((run) => !claimed.has(runKey(run))));

      if (failed === 0) {
        toast.success(
          ok === 1 ? `Claimed ${target[0]?.runId}.` : `Claimed ${ok} runs.`
        );
      } else if (ok === 0) {
        toast.error(
          failed === 1
            ? "Couldn't claim this run. Try again?"
            : "Couldn't claim these runs. Try again?"
        );
      } else {
        toast.warning(
          `Claimed ${ok} ${ok === 1 ? "run" : "runs"}, ${failed} failed. Try again?`
        );
      }
      router.refresh();
    });
  }

  function dismiss() {
    const target = runsRef.current;
    writeDismissedClaimPrompts(
      addDismissed(readDismissedClaimPrompts(), userId, target)
    );
    trackClientEvent("claim_prompt_answered", {
      answer: "dismissed",
      runs: target.length,
    });
    showRuns([]);
  }

  const value = useMemo(() => ({ ask }), [ask]);

  return (
    <ClaimPromptContext.Provider value={value}>
      {children}
      <ClaimPromptCard
        isPending={isPending}
        onClaim={claim}
        onDismiss={dismiss}
        runs={runs}
      />
    </ClaimPromptContext.Provider>
  );
}
