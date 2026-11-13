"use client";

import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useMemo,
} from "react";
import { useClaimPrompt } from "@/hooks/use-claim-prompt";
import type { ClaimPromptCandidate } from "@/lib/runs/claim-prompt";

const RunClaimTargetContext = createContext<ClaimPromptCandidate | null>(null);

// The run a run page's downloads come from. The page re-renders this with
// fresh props after a claim, so `unclaimed` stays current.
export function RunClaimTargetProvider({
  children,
  instrumentId,
  runId,
  unclaimed,
}: ClaimPromptCandidate & { children: ReactNode }) {
  const value = useMemo(
    () => ({ instrumentId, runId, unclaimed }),
    [instrumentId, runId, unclaimed]
  );
  return (
    <RunClaimTargetContext.Provider value={value}>
      {children}
    </RunClaimTargetContext.Provider>
  );
}

/**
 * Call after a download starts on a run page. It asks whether the person ran
 * the run when nobody has claimed it. Off a run page it does nothing.
 */
export function useRunDownloadClaimPrompt(): () => void {
  const target = use(RunClaimTargetContext);
  const { ask } = useClaimPrompt();
  return useCallback(() => {
    if (target) {
      ask([target]);
    }
  }, [ask, target]);
}
