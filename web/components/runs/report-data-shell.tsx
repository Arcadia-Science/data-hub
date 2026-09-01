import type { ReactNode } from "react";
import { RunSectionCard } from "@/components/runs/run-section-card";

export function ReportDataEmpty({ title = "Report Data" }: { title?: string }) {
  return (
    <RunSectionCard title={title}>
      <p className="text-muted-foreground text-sm">
        No report data has been generated for this run.
      </p>
    </RunSectionCard>
  );
}

// Chrome shared by every report-data viewer. `count` is the unfiltered item
// count, so the heading holds steady while a search narrows the list inside.
// Omit it for a card whose contents are not a countable list of items.
export function ReportDataShell({
  children,
  contentClassName = "gap-3",
  count,
  title = "Report Data",
}: {
  children: ReactNode;
  contentClassName?: string;
  count?: number;
  title?: string;
}) {
  if (count === 0) {
    return <ReportDataEmpty title={title} />;
  }

  return (
    <RunSectionCard
      contentClassName={contentClassName}
      count={count}
      title={title}
    >
      {children}
    </RunSectionCard>
  );
}
