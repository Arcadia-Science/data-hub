"use client";

import { ConfirmInstrumentDialog } from "@/components/instruments/confirm-instrument-dialog";
import { ConfirmReviewSummary } from "@/components/instruments/confirm-review-summary";
import { Button } from "@/components/ui/button";
import type { InstrumentConfirmReview } from "@/lib/instruments/confirm-review";

/**
 * The admin's card on a pending instrument's page, in place of the runs table.
 * It shows the watcher's settings and the button that opens the Confirm dialog.
 */
export function PendingInstrumentCard({
  review,
}: {
  review: InstrumentConfirmReview;
}) {
  return (
    <section
      aria-labelledby="pending-instrument-heading"
      className="flex flex-col gap-3 rounded-xl border bg-card p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            className="font-semibold text-base"
            id="pending-instrument-heading"
          >
            Waiting for confirmation
          </h2>
          <p className="text-muted-foreground text-sm">
            Check what the watcher was set up to do. Runs appear here after you
            confirm.
          </p>
        </div>
        <ConfirmInstrumentDialog
          displayName={review.displayName}
          instrumentId={review.instrumentId}
        >
          <Button size="sm" type="button">
            Confirm…
          </Button>
        </ConfirmInstrumentDialog>
      </div>
      <ConfirmReviewSummary review={review} />
    </section>
  );
}
