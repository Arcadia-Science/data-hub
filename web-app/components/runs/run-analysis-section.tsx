"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FlaskConical } from "lucide-react";

export function RunAnalysisSection() {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Analysis</h2>
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
      </div>
      <Card size="sm">
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No analysis results yet. The analysis pipeline is not yet available.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
