import type { ReactNode } from "react";
import { RunSectionCard } from "@/components/runs/run-section-card";

// Chrome shared by every report-data viewer. `total` is the unfiltered count,
// so the heading holds steady while a search narrows the list inside.
export function ReportDataShell({
  children,
  contentClassName = "gap-3",
  title = "Report Data",
  total,
}: {
  children: ReactNode;
  contentClassName?: string;
  title?: string;
  total: number;
}) {
  if (total === 0) {
    return (
      <RunSectionCard title={title}>
        <p className="text-muted-foreground text-sm">
          No report data has been generated for this run.
        </p>
      </RunSectionCard>
    );
  }

  return (
    <RunSectionCard
      contentClassName={contentClassName}
      count={total}
      title={title}
    >
      {children}
    </RunSectionCard>
  );
}
