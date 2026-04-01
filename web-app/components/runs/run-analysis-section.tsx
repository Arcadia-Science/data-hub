"use client";

import { ReportDataTable } from "@/components/runs/report-data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { RunReportEntry } from "@/lib/api/instrument-runs";
import { FlaskConical } from "lucide-react";

export function RunAnalysisSection({
  analysisData,
}: {
  analysisData: RunReportEntry[];
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Analysis</span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0}>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  disabled
                >
                  <FlaskConical className="size-3" />
                  Run Analysis
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>Coming soon</TooltipContent>
          </Tooltip>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {analysisData.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No analysis results yet. The analysis pipeline is not yet available.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {analysisData.map((entry) => (
              <div key={entry.id} className="flex flex-col gap-1.5">
                <Badge
                  variant="outline"
                  className="w-fit font-mono text-[10px]"
                >
                  {entry.dataType}
                </Badge>
                <ReportDataTable data={entry.data} />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
