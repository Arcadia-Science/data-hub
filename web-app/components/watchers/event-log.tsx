"use client";

import { PaginationNav } from "@/components/pagination-nav";
import { Badge } from "@/components/ui/badge";
import type { WatcherEventRow } from "@/lib/api/watchers";
import { cn, formatRelativeTime } from "@/lib/utils";
import { ChevronDown, Inbox } from "lucide-react";
import { useState } from "react";

const eventTypeMeta: Record<
  string,
  {
    variant: "default" | "destructive" | "outline" | "secondary";
    label: string;
  }
> = {
  file_uploaded: { variant: "default", label: "File Uploaded" },
  config_synced: { variant: "default", label: "Config Synced" },
  upload_failed: { variant: "destructive", label: "Upload Failed" },
  error: { variant: "destructive", label: "Error" },
  watcher_started: { variant: "outline", label: "Started" },
  watcher_stopped: { variant: "outline", label: "Stopped" },
  run_reported: { variant: "outline", label: "Run Reported" },
};

function EventEntry({ event }: { event: WatcherEventRow }) {
  const [expanded, setExpanded] = useState(false);
  const meta = eventTypeMeta[event.eventType] ?? {
    variant: "secondary" as const,
    label: event.eventType,
  };
  const hasDetails = event.details != null;

  return (
    <div className="flex flex-col gap-1 border-b px-4 py-3 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge variant={meta.variant} className="text-[10px]">
            {meta.label}
          </Badge>
          <span className="text-sm">{event.message}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {formatRelativeTime(event.timestamp)}
          </span>
          {hasDetails && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-muted-foreground transition-colors hover:text-foreground"
              aria-label={expanded ? "Collapse details" : "Expand details"}
            >
              <ChevronDown
                className={cn(
                  "size-4 transition-transform",
                  expanded && "rotate-180"
                )}
              />
            </button>
          )}
        </div>
      </div>
      {expanded && hasDetails && (
        <pre className="mt-1 overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
          {JSON.stringify(event.details, null, 2)}
        </pre>
      )}
    </div>
  );
}

export function EventLog({
  events,
  page,
  totalPages,
}: {
  events: WatcherEventRow[];
  page: number;
  totalPages: number;
}) {
  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-8">
        <Inbox className="size-6 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          No events in this time range.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <div className="divide-y">
        {events.map((event) => (
          <EventEntry key={event.id} event={event} />
        ))}
      </div>
      <PaginationNav
        page={page}
        totalPages={totalPages}
        pageParam="logs_page"
      />
    </div>
  );
}
