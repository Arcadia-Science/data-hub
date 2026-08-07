import type { ReactNode } from "react";
import { RunSectionHeading } from "@/components/runs/run-section-heading";
import { Card, CardContent } from "@/components/ui/card";

// Chrome shared by every report-data viewer. `total` is the unfiltered count,
// so the heading holds steady while a search narrows the list inside.
export function ReportDataShell({
  children,
  title = "Report Data",
  total,
}: {
  children: ReactNode;
  title?: string;
  total: number;
}) {
  if (total === 0) {
    return (
      <div className="flex flex-col gap-2">
        <RunSectionHeading title={title} />
        <Card size="sm">
          <CardContent>
            <p className="text-muted-foreground text-sm">
              No report data has been generated for this run.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <RunSectionHeading countLabel={total} title={title} />
      <Card size="sm">
        <CardContent className="flex flex-col gap-3">{children}</CardContent>
      </Card>
    </div>
  );
}
