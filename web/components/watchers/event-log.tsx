"use client";

import { ChevronDown, Inbox } from "lucide-react";
import Link from "next/link";
import { useQueryStates } from "nuqs";
import { useId, useState } from "react";
import { CopyButton } from "@/components/copy-button";
import { RelativeTime } from "@/components/dashboard/relative-time";
import { EmptyState } from "@/components/empty-state";
import {
  TablePendingBoundary,
  useTablePending,
} from "@/components/table-pending";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useViewerTimeZone } from "@/components/viewer-time-zone-provider";
import { formatDateTimeShort } from "@/lib/date";
import {
  WATCHER_EVENTS_MAX_SHOWN,
  WATCHER_EVENTS_PAGE_SIZE,
  watcherDetailSearchParams,
} from "@/lib/search-params";
import { cn } from "@/lib/utils";
import type {
  EventDescription,
  EventFact,
  EventTone,
  MessagePart,
} from "@/lib/watchers/event-messages";

/** One event, ready to draw. The server describes it, so the page ships no raw details to members. */
export interface ActivityRow {
  description: EventDescription;
  id: number;
  /**
   * The event as the watcher sent it, as JSON and as highlighted HTML from
   * the server. Set for admins only.
   */
  raw: { html: string; json: string } | null;
  /** ISO 8601. */
  timestamp: string;
}

const TONE_CLASSNAMES: Record<EventTone, string> = {
  success: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  info: "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  update:
    "bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300",
  neutral: "bg-slate-100 text-slate-700 dark:bg-slate-950 dark:text-slate-300",
  muted: "bg-muted text-muted-foreground dark:bg-slate-950 dark:text-slate-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  error: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

const LINK_CLASSNAME =
  "pointer-events-auto font-medium text-foreground underline underline-offset-3 outline-none hover:text-foreground/80 focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring";

function runHref(instrumentId: string, runId: string): string {
  return `/instruments/${encodeURIComponent(instrumentId)}/runs/${encodeURIComponent(runId)}`;
}

function Message({
  instrumentId,
  parts,
}: {
  instrumentId: string;
  parts: MessagePart[];
}) {
  return (
    <>
      {parts.map((part, index) => {
        // Parts never reorder: they are built from one event.
        const key = `${part.kind}-${index}`;
        switch (part.kind) {
          case "text":
            return <span key={key}>{part.text}</span>;
          case "file":
            return (
              <span
                className="break-all font-mono text-[13px] text-foreground"
                key={key}
              >
                {part.name}
              </span>
            );
          case "run":
            return (
              <Link
                className={LINK_CLASSNAME}
                href={runHref(instrumentId, part.runId)}
                key={key}
              >
                {part.runId}
              </Link>
            );
          default:
            return part satisfies never;
        }
      })}
    </>
  );
}

function Fact({
  fact,
  instrumentId,
}: {
  fact: EventFact;
  instrumentId: string;
}) {
  switch (fact.kind) {
    case "value":
      return (
        <span>
          {fact.label}{" "}
          <b className="font-medium text-foreground">{fact.value}</b>
        </span>
      );
    case "run":
      return (
        <span>
          Run{" "}
          <Link
            className={cn(LINK_CLASSNAME, "break-all")}
            href={runHref(instrumentId, fact.runId)}
          >
            {fact.runId}
          </Link>
        </span>
      );
    case "note":
      return <span>{fact.text}</span>;
    default:
      return fact satisfies never;
  }
}

function EventRow({
  instrumentId,
  row,
}: {
  instrumentId: string;
  row: ActivityRow;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const timeZone = useViewerTimeZone();
  const { description } = row;

  return (
    <li className="border-t first:border-t-0">
      <div className="relative min-h-12 px-4 py-2 hover:bg-muted/40">
        {/* The whole row opens the details, but a run in the message is a link,
            and a link can't sit inside a button. So the button lies under the
            row, and the row ignores the pointer except for its links. */}
        <button
          aria-controls={panelId}
          aria-expanded={open}
          aria-label={`${description.label}: ${description.text}`}
          className="absolute inset-0 cursor-pointer outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={() => setOpen((value) => !value)}
          type="button"
        />
        <div className="pointer-events-none relative flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 text-sm sm:flex-nowrap">
          <span className="shrink-0 sm:w-[132px]">
            <Badge
              className={cn(
                "h-[22px] rounded-md",
                TONE_CLASSNAMES[description.tone]
              )}
              variant="secondary"
            >
              {description.label}
            </Badge>
          </span>
          <span className="order-last min-w-0 basis-full break-words sm:order-none sm:flex-1 sm:basis-0">
            <Message instrumentId={instrumentId} parts={description.message} />
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-3 sm:ml-0">
            <RelativeTime
              className="pointer-events-none text-muted-foreground"
              date={row.timestamp}
            />
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-4 text-muted-foreground transition-transform",
                open && "rotate-180"
              )}
            />
          </span>
        </div>
      </div>
      {open && (
        <div
          className="flex flex-col gap-3 px-4 pb-3.5 text-[13px] text-muted-foreground"
          id={panelId}
        >
          {row.raw ? <RawEvent raw={row.raw} /> : null}
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            {description.facts.map((fact, index) => (
              <Fact
                fact={fact}
                instrumentId={instrumentId}
                // Facts never reorder: they are built from one event.
                key={`${fact.kind}-${index}`}
              />
            ))}
            <span>
              {formatDateTimeShort(new Date(row.timestamp), timeZone)}
            </span>
          </div>
        </div>
      )}
    </li>
  );
}

function RawEvent({ raw }: { raw: NonNullable<ActivityRow["raw"]> }) {
  return (
    <div className="relative">
      <CopyButton
        className="absolute top-1.5 right-1.5 z-10 text-muted-foreground"
        label="Copy raw event"
        size="icon-xs"
        value={raw.json}
        variant="ghost"
      />
      <div
        className="overflow-x-auto rounded-md bg-muted font-mono text-xs leading-relaxed [&_pre]:p-3"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki emits syntax-highlighting markup and escapes the event's text
        dangerouslySetInnerHTML={{ __html: raw.html }}
      />
    </div>
  );
}

/**
 * The event log: a row per event, newest first, and "Showing n of N" with a
 * "Show more" button in place of page numbers. A row opens to show its details.
 */
export function EventLog({
  instrumentId,
  rows,
  total,
}: {
  instrumentId: string;
  rows: ActivityRow[];
  total: number;
}) {
  const { isPending, startTransition } = useTablePending();
  const [{ shown }, setFilters] = useQueryStates(watcherDetailSearchParams, {
    shallow: false,
    startTransition,
  });

  if (rows.length === 0) {
    return (
      <TablePendingBoundary>
        <EmptyState className="rounded-xl" icon={Inbox} size="compact">
          No events in this time range.
        </EmptyState>
      </TablePendingBoundary>
    );
  }

  const canShowMore = rows.length < total && shown < WATCHER_EVENTS_MAX_SHOWN;

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <TablePendingBoundary>
        <ul>
          {rows.map((row) => (
            <EventRow instrumentId={instrumentId} key={row.id} row={row} />
          ))}
        </ul>
      </TablePendingBoundary>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-[13px] text-muted-foreground">
        <span aria-live="polite">
          Showing {rows.length} of {total}
        </span>
        {canShowMore && (
          <Button
            onClick={() => {
              if (isPending) {
                return;
              }
              setFilters({
                shown: Math.min(
                  shown + WATCHER_EVENTS_PAGE_SIZE,
                  WATCHER_EVENTS_MAX_SHOWN
                ),
              });
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Show more
          </Button>
        )}
      </div>
    </div>
  );
}
