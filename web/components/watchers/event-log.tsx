"use client";

import { Inbox } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import { PaginationNav } from "@/components/pagination-nav";
import { TablePendingBoundary } from "@/components/table-pending";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import type { WatcherEventRow } from "@/lib/api/watchers";
import { formatRelativeTime } from "@/lib/utils";

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
  const meta = eventTypeMeta[event.eventType] ?? {
    variant: "secondary" as const,
    label: event.eventType,
  };
  const hasDetails = event.details != null;

  const trigger = (
    <div className="flex w-full items-start justify-between gap-3">
      <div className="flex items-center gap-4">
        <Badge className="text-[10px]" variant={meta.variant}>
          {meta.label}
        </Badge>
        <span className="text-sm">{event.message}</span>
      </div>
      <span className="me-2 shrink-0 text-muted-foreground text-xs">
        {formatRelativeTime(event.timestamp)}
      </span>
    </div>
  );

  if (!hasDetails) {
    return <div className="flex items-start px-4 py-3">{trigger}</div>;
  }

  return (
    <AccordionItem className="border-b last:border-0" value={String(event.id)}>
      <AccordionTrigger className="cursor-pointer px-4 py-3 hover:no-underline">
        {trigger}
      </AccordionTrigger>
      <AccordionContent className="px-4 pb-3">
        <div className="relative">
          <CopyButton
            className="absolute top-1.5 right-1.5 text-muted-foreground"
            size="icon-xs"
            value={JSON.stringify(event.details, null, 2)}
            variant="ghost"
          />
          <pre className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed">
            {JSON.stringify(event.details, null, 2)}
          </pre>
        </div>
      </AccordionContent>
    </AccordionItem>
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
      <TablePendingBoundary>
        <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed bg-background py-8 dark:bg-muted">
          <Inbox className="size-6 text-muted-foreground" />
          <p className="text-muted-foreground text-sm">
            No events in this time range.
          </p>
        </div>
      </TablePendingBoundary>
    );
  }

  return (
    <div className="rounded-md border bg-background dark:bg-muted">
      <TablePendingBoundary>
        <Accordion className="divide-y" type="multiple">
          {events.map((event) => (
            <EventEntry event={event} key={event.id} />
          ))}
        </Accordion>
      </TablePendingBoundary>
      <PaginationNav
        page={page}
        pageParam="logs_page"
        totalPages={totalPages}
      />
    </div>
  );
}
