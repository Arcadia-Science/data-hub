"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { ClaimPromptRun } from "@/lib/runs/claim-prompt";
import { runKey } from "@/lib/runs/claim-prompt";

const LISTED_RUNS = 3;

// Sits bottom-right, above the floating bulk action bars (`bottom-6`), and
// below dialogs (`z-50`), so an open dialog covers it instead of leaving
// buttons that can't be clicked. The live region stays mounted so screen
// readers announce the card when it appears.
export function ClaimPromptCard({
  isPending,
  onClaim,
  onDismiss,
  runs,
}: {
  isPending: boolean;
  onClaim: () => void;
  onDismiss: () => void;
  runs: readonly ClaimPromptRun[];
}) {
  const titleId = useId();
  const single = runs.length === 1 ? runs[0] : null;
  const listed = runs.slice(0, LISTED_RUNS);
  const unlisted = runs.length - listed.length;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-4 bottom-24 z-40 flex justify-end sm:right-6 sm:left-auto"
    >
      {runs.length > 0 ? (
        <Card
          aria-labelledby={titleId}
          className="fade-in slide-in-from-bottom-4 pointer-events-auto w-full animate-in shadow-lg sm:w-80"
          role="region"
          size="sm"
        >
          <CardHeader>
            <CardTitle id={titleId}>
              {single ? "Did you run this?" : "Did you run these?"}
            </CardTitle>
            <CardDescription>
              {single ? (
                <>
                  Nobody has claimed{" "}
                  <span className="break-all font-mono text-foreground">
                    {single.runId}
                  </span>{" "}
                  yet. Claim it if you ran it, so others know who to ask.
                </>
              ) : (
                <>
                  Nobody has claimed these {runs.length} runs yet. Claim them if
                  you ran them, so others know who to ask.
                </>
              )}
            </CardDescription>
            {single ? null : (
              <ul className="mt-1 space-y-0.5 text-sm">
                {listed.map((run) => (
                  <li className="break-all font-mono" key={runKey(run)}>
                    {run.runId}
                  </li>
                ))}
                {unlisted > 0 ? (
                  <li className="text-muted-foreground">and {unlisted} more</li>
                ) : null}
              </ul>
            )}
          </CardHeader>
          <CardFooter className="justify-end gap-2">
            <Button
              disabled={isPending}
              onClick={onDismiss}
              size="sm"
              type="button"
              variant="ghost"
            >
              Not me
            </Button>
            <Button
              disabled={isPending}
              onClick={onClaim}
              size="sm"
              type="button"
            >
              {single ? "I ran this" : "I ran these"}
            </Button>
          </CardFooter>
        </Card>
      ) : null}
    </div>
  );
}
