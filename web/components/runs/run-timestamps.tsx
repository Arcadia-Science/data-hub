"use client";

import { FileText, Play, RefreshCw } from "lucide-react";
import { useViewerTimeZone } from "@/components/viewer-time-zone-provider";
import type { RunDetail } from "@/lib/api/instrument-runs";
import { formatDateTimeShort } from "@/lib/date";

export function RunTimestamps({ run }: { run: RunDetail }) {
  const timeZone = useViewerTimeZone();

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-muted-foreground text-xs">
      {run.acquiredAt && (
        <span className="inline-flex items-center gap-1.5">
          <Play aria-hidden="true" className="size-3.5 shrink-0" />
          Run started {formatDateTimeShort(run.acquiredAt, timeZone)}
        </span>
      )}
      <span className="inline-flex items-center gap-1.5">
        <FileText aria-hidden="true" className="size-3.5 shrink-0" />
        Reported {formatDateTimeShort(run.createdAt, timeZone)}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <RefreshCw aria-hidden="true" className="size-3.5 shrink-0" />
        Updated {formatDateTimeShort(run.updatedAt, timeZone)}
      </span>
    </div>
  );
}
