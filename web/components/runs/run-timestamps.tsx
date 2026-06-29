"use client";

import { FileText, Play, RefreshCw } from "lucide-react";
import type { RunDetail } from "@/lib/api/instrument-runs";
import { formatDateTimeShort } from "@/lib/date";

// Must stay a client component: `formatDateTimeShort` resolves the timezone at
// runtime, so rendering on the server uses UTC and shifts every timestamp by
// the viewer's offset.
export function RunTimestamps({ run }: { run: RunDetail }) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 text-muted-foreground text-sm">
      {run.acquiredAt && (
        <span className="inline-flex items-center gap-1.5">
          <Play aria-hidden="true" className="size-3.5 shrink-0" />
          Run started {formatDateTimeShort(run.acquiredAt)}
        </span>
      )}
      <span className="inline-flex items-center gap-1.5">
        <FileText aria-hidden="true" className="size-3.5 shrink-0" />
        Reported {formatDateTimeShort(run.createdAt)}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <RefreshCw aria-hidden="true" className="size-3.5 shrink-0" />
        Updated {formatDateTimeShort(run.updatedAt)}
      </span>
    </div>
  );
}
