import type { ReactNode } from "react";
import { FilePatterns } from "@/components/instruments/file-patterns";
import {
  type InstrumentConfirmReview,
  runDetectionName,
  workedRunExample,
} from "@/lib/instruments/confirm-review";

const EMPTY = <span className="text-muted-foreground">&mdash;</span>;

function SummaryRow({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="grid gap-x-3 gap-y-1 border-border border-t py-2.5 first:border-t-0 sm:grid-cols-[170px_minmax(0,1fr)]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-1 text-sm [overflow-wrap:anywhere]">
        {children}
      </dd>
    </div>
  );
}

/**
 * The settings a pending instrument's watcher was set up with, as label and
 * value rows. The Confirm dialog and the pending instrument's page both show it.
 */
export function ConfirmReviewSummary({
  review,
}: {
  review: InstrumentConfirmReview;
}) {
  const { watcher } = review;
  const detection = watcher?.runDetection ?? null;
  const example = detection
    ? workedRunExample(detection.pattern, review.recentFilePath)
    : null;

  return (
    <dl className="m-0">
      <SummaryRow label="Registered from">
        {watcher?.hostname ? (
          <span className="font-mono text-[13px]">{watcher.hostname}</span>
        ) : (
          EMPTY
        )}
        {watcher?.tokenName ? (
          <span className="text-muted-foreground">
            · token “{watcher.tokenName}”
          </span>
        ) : null}
      </SummaryRow>
      <SummaryRow label="Watch folder">
        {watcher?.watchDirectory ? (
          <span className="font-mono text-[13px]">
            {watcher.watchDirectory}
          </span>
        ) : (
          EMPTY
        )}
      </SummaryRow>
      <SummaryRow label="File patterns">
        <FilePatterns patterns={watcher?.filePatterns ?? []} />
      </SummaryRow>
      <SummaryRow label="How files become runs">
        {detection ? (
          <>
            <span>{runDetectionName(detection.pattern)}.</span>
            {example ? (
              <>
                <span className="font-mono text-muted-foreground text-xs">
                  {example.path}
                </span>
                <span>→ run</span>
                <span className="font-mono text-xs">{example.runId}</span>
              </>
            ) : null}
          </>
        ) : (
          EMPTY
        )}
      </SummaryRow>
      <SummaryRow label="Upload mode">
        {watcher
          ? watcher.uploadMode === "manual"
            ? "Manual"
            : "Automatic"
          : EMPTY}
      </SummaryRow>
    </dl>
  );
}
