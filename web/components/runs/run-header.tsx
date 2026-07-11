"use client";

import { Trash2 } from "lucide-react";
import Link from "next/link";
import { RecordInstrumentVisit } from "@/components/recent-instrument-visit";
import { RunSwitcher } from "@/components/runs/run-switcher";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { UserAvatarLink } from "@/components/user-avatar";
import type { RunDetail } from "@/lib/api/instrument-runs";
import { formatDateTime } from "@/lib/date";

// Must stay a client component: `formatDateTime` resolves the timezone at
// runtime, so rendering on the server uses UTC and shifts every timestamp by
// the viewer's offset (disagreeing with the client-rendered files table).
export function RunHeader({
  run,
  runNavSlot,
  children,
}: {
  run: RunDetail;
  // Previous/next run navigation, rendered to the left of the action buttons.
  runNavSlot?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <RecordInstrumentVisit
        displayName={run.instrumentDisplayName}
        instrumentId={run.instrumentId}
      />
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/">Home</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href="/instruments">Instruments</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link href={`/instruments/${run.instrumentId}`}>
                {run.instrumentDisplayName}
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <RunSwitcher run={run} />
        </BreadcrumbList>
      </Breadcrumb>

      {run.deletedAt && (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-destructive text-sm">
          <Trash2 className="size-4 shrink-0" />
          <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span>Deleted {formatDateTime(run.deletedAt)}</span>
            {run.deletedByUser && (
              <span className="flex items-center gap-1.5">
                <span>by</span>
                <UserAvatarLink size="sm" user={run.deletedByUser}>
                  <span className="font-medium">
                    {run.deletedByUser.displayName}
                  </span>
                </UserAvatarLink>
              </span>
            )}
          </span>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-mono font-semibold text-2xl tracking-tight">
          {run.runId}
        </h1>

        <div className="flex items-center gap-2">
          {runNavSlot}
          {children}
        </div>
      </div>
    </div>
  );
}
