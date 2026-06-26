"use client";

import { Trash2 } from "lucide-react";
import Link from "next/link";
import { RunSwitcher } from "@/components/runs/run-switcher";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import type { RunDetail } from "@/lib/api/instrument-runs";
import { avatarColor } from "@/lib/avatar-color";
import { formatDateTime } from "@/lib/date";

// Must stay a client component: `formatDateTime` resolves the timezone at
// runtime, so rendering on the server uses UTC and shifts every timestamp by
// the viewer's offset (disagreeing with the client-rendered files table).
export function RunHeader({
  run,
  children,
  attributionsSlot,
}: {
  run: RunDetail;
  children?: React.ReactNode;
  attributionsSlot?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
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
                <Avatar size="sm">
                  {run.deletedByUser.avatarUrl ? (
                    <AvatarImage
                      alt={run.deletedByUser.displayName}
                      src={run.deletedByUser.avatarUrl}
                    />
                  ) : null}
                  <AvatarFallback
                    className={avatarColor(run.deletedByUser.userId)}
                  >
                    {run.deletedByUser.initials}
                  </AvatarFallback>
                </Avatar>
                <span className="font-medium">
                  {run.deletedByUser.displayName}
                </span>
              </span>
            )}
          </span>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-mono font-semibold text-2xl tracking-tight">
          {run.runId}
        </h1>

        <div className="flex items-center gap-2">{children}</div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm">
        {run.acquiredAt && (
          <>
            <span>Run started {formatDateTime(run.acquiredAt)}</span>
            <span className="text-muted-foreground/40">&middot;</span>
          </>
        )}
        <span>Reported {formatDateTime(run.createdAt)}</span>
        <span className="text-muted-foreground/40">&middot;</span>
        <span>Updated {formatDateTime(run.updatedAt)}</span>
        {attributionsSlot && (
          <>
            <span className="text-muted-foreground/40">&middot;</span>
            {attributionsSlot}
          </>
        )}
      </div>
    </div>
  );
}
