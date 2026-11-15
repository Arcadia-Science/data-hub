"use client";

import {
  ChevronDown,
  ChevronsUpDown,
  ChevronUp,
  Layers,
  SearchX,
} from "lucide-react";
import { useMemo, useState } from "react";
import { RelativeTime } from "@/components/dashboard/relative-time";
import { EmptyState } from "@/components/empty-state";
import { RowControl, RowLink } from "@/components/row-link";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useViewerTimeZone } from "@/components/viewer-time-zone-provider";
import { WatcherActions } from "@/components/watchers/watcher-actions";
import {
  ConfigChangeBadge,
  RestartPendingBadge,
} from "@/components/watchers/watcher-config-status";
import { WatcherStatusBadge } from "@/components/watchers/watcher-status-badge";
import { formatDate } from "@/lib/date";
import type { InstrumentWatcherConfigState } from "@/lib/instruments/connection";
import {
  type ActiveWatcherRow,
  type ComputerSort,
  type DeregisteredWatcherRow,
  type SharedComputerMarker,
  sharedComputerMarker,
  sortActiveWatchers,
} from "@/lib/watchers/roster";
import { watcherPageHref } from "@/lib/watchers/routes";

/** Placeholder with the active table's columns, so the rows swap in without a shift. */
export function WatchersTableSkeleton({ rows = 7 }: { rows?: number }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading watchers"
      className="rounded-lg border bg-background dark:bg-muted"
      role="status"
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Instrument</TableHead>
            <TableHead>Computer</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Settings</TableHead>
            <TableHead>Last heartbeat</TableHead>
            <TableHead className="w-12">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, i) => (
            <TableRow className="text-sm" key={i}>
              <TableCell>
                <Skeleton className="h-4 w-40" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-12" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-24" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-20" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-20" />
              </TableCell>
              <TableCell>
                <Skeleton className="ml-auto size-7" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** The em dash that stands for a value a watcher doesn't have. */
function Dash() {
  return <span className="text-muted-foreground">—</span>;
}

/** The computer's name, or a dash when the watcher reported none or a blank one. */
function ComputerName({ hostname }: { hostname: string | null }) {
  const name = hostname?.trim();
  return name ? <span className="font-mono text-xs">{name}</span> : <Dash />;
}

/** Active watchers, sortable by computer. Rows open the instrument's watcher page. */
export function ActiveWatchersTable({ rows }: { rows: ActiveWatcherRow[] }) {
  const [computerSort, setComputerSort] = useState<ComputerSort>(null);
  const sorted = useMemo(
    () => sortActiveWatchers(rows, computerSort),
    [rows, computerSort]
  );

  if (rows.length === 0) {
    return <EmptyState icon={SearchX}>No active watchers.</EmptyState>;
  }

  return (
    <div className="rounded-lg border bg-background dark:bg-muted">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Instrument</TableHead>
            <TableHead aria-sort={computerSort ?? "none"}>
              <button
                className="inline-flex items-center gap-1.5 rounded-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setComputerSort(nextComputerSort(computerSort))}
                type="button"
              >
                Computer
                <SortIcon sort={computerSort} />
              </button>
            </TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Settings</TableHead>
            <TableHead>Last heartbeat</TableHead>
            <TableHead className="w-12">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((row) => {
            const marker = sharedComputerMarker(row.sharedComputerWith);
            return (
              <TableRow className="relative text-sm" key={row.id}>
                <TableCell>
                  <RowLink href={watcherPageHref(row.instrumentId)}>
                    {row.instrumentDisplayName ?? (
                      <span className="font-mono text-muted-foreground">
                        {row.instrumentId}
                      </span>
                    )}
                  </RowLink>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <ComputerName hostname={row.hostname} />
                    {marker ? (
                      <RowControl className="flex">
                        <SharedComputerIcon marker={marker} />
                      </RowControl>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {row.watcherVersion ?? <Dash />}
                </TableCell>
                <TableCell>
                  <RowControl>
                    <WatcherStatusBadge
                      className="text-xs"
                      lastOnlineAt={row.lastHeartbeatAt}
                      reason={row.statusReason}
                      status={row.effectiveStatus}
                    />
                  </RowControl>
                </TableCell>
                <TableCell>
                  <ConfigStateBadge state={row.configState} />
                </TableCell>
                <TableCell>
                  {row.lastHeartbeatAt ? (
                    <RelativeTime date={row.lastHeartbeatAt.toISOString()} />
                  ) : (
                    <Dash />
                  )}
                </TableCell>
                <TableCell>
                  <RowControl>
                    <WatcherActions watcher={row} />
                  </RowControl>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** Deregistered watchers, read-only. Rows open the registration they name. */
export function DeregisteredWatchersTable({
  rows,
}: {
  rows: DeregisteredWatcherRow[];
}) {
  const timeZone = useViewerTimeZone();

  if (rows.length === 0) {
    return <EmptyState icon={SearchX}>No deregistered watchers.</EmptyState>;
  }

  return (
    <div className="rounded-lg border bg-background dark:bg-muted">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Instrument</TableHead>
            <TableHead>Computer</TableHead>
            <TableHead>Last version</TableHead>
            <TableHead>Deregistered on</TableHead>
            <TableHead>Deregistered by</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow className="relative text-sm" key={row.id}>
              <TableCell>
                <RowLink
                  href={watcherPageHref(row.instrumentId, {
                    watcherId: row.id,
                  })}
                >
                  {row.instrumentDisplayName ?? (
                    <span className="font-mono text-muted-foreground">
                      {row.instrumentId}
                    </span>
                  )}
                </RowLink>
              </TableCell>
              <TableCell>
                <ComputerName hostname={row.hostname} />
              </TableCell>
              <TableCell className="font-mono text-xs">
                {row.watcherVersion ?? <Dash />}
              </TableCell>
              <TableCell>
                {row.deletedAt ? formatDate(row.deletedAt, timeZone) : <Dash />}
              </TableCell>
              <TableCell>{row.deregisteredByName ?? <Dash />}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// The icon is focusable, so a keyboard user can open its tooltip too. Its
// accessible name is the count the tooltip leads with.
function SharedComputerIcon({ marker }: { marker: SharedComputerMarker }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={marker.label}
          className="inline-flex cursor-default rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          role="img"
          tabIndex={0}
        >
          <Layers aria-hidden="true" className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent className="flex flex-col items-start gap-0.5">
        <p className="font-semibold">{marker.label}</p>
        <p>{marker.tooltip}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function ConfigStateBadge({ state }: { state: InstrumentWatcherConfigState }) {
  if (state === "pending" || state === "rejected") {
    return <ConfigChangeBadge className="text-xs" status={state} />;
  }
  if (state === "edited_on_pc") {
    return <RestartPendingBadge className="text-xs" />;
  }
  return <Dash />;
}

function SortIcon({ sort }: { sort: ComputerSort }) {
  if (sort === "ascending") {
    return <ChevronUp aria-hidden="true" className="size-3" />;
  }
  if (sort === "descending") {
    return <ChevronDown aria-hidden="true" className="size-3" />;
  }
  return (
    <ChevronsUpDown
      aria-hidden="true"
      className="size-3 text-muted-foreground"
    />
  );
}

/** The header click cycles: none, then ascending, then descending, then none. */
function nextComputerSort(sort: ComputerSort): ComputerSort {
  if (sort === null) {
    return "ascending";
  }
  return sort === "ascending" ? "descending" : null;
}
