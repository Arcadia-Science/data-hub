"use client";

import { CloudUpload } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import {
  CodeBadge,
  FilePatterns,
} from "@/components/instruments/file-patterns";
import { InstrumentActions } from "@/components/instruments/instrument-actions";
import { InstrumentBadge } from "@/components/instruments/instrument-badge";
import { InstrumentNotificationPill } from "@/components/notifications/instrument-notification-toggle";
import { RecordInstrumentVisit } from "@/components/recent-instrument-visit";
import { ActorLabel } from "@/components/token-actor";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useViewerTimeZone } from "@/components/viewer-time-zone-provider";
import type { InstrumentDetail } from "@/lib/api/instruments";
import { formatDate } from "@/lib/date";

export function InstrumentHeaderSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading instrument"
      className="flex flex-col gap-2"
      role="status"
    >
      <Skeleton className="mb-2 h-4 w-56" />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Skeleton className="h-8 w-64" />
            <Skeleton className="h-5 w-16 rounded-full" />
          </div>
          <Skeleton className="h-5 w-72" />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-md" />
        </div>
      </div>
    </div>
  );
}

// Shown whenever the watcher's upload mode is manual, whatever the badge says.
// Manual mode isn't a problem, so it gets a permanent note, not a notice.
function ManualUploadPill() {
  return (
    <Badge className="gap-1.5 bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-300">
      <CloudUpload aria-hidden="true" />
      Files upload when someone requests them
    </Badge>
  );
}

// Selecting the folder copies its path, for pasting into File Explorer on the
// instrument PC.
function WatchDirectory({ path }: { path: string }) {
  async function copyPath() {
    try {
      await navigator.clipboard.writeText(path);
      toast.success("Folder path copied");
    } catch {
      toast.error("Couldn't copy the folder path.");
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className="group/folder flex min-w-0 cursor-pointer rounded-4xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={copyPath}
          type="button"
        >
          <span className="sr-only">Copy watched folder: </span>
          {/* A long path wraps inside the badge instead of being cut off. */}
          <CodeBadge className="h-auto min-h-5 min-w-0 shrink justify-start whitespace-normal break-all group-hover/folder:bg-slate-300 dark:group-hover/folder:bg-slate-600">
            {path}
          </CodeBadge>
        </button>
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5" side="bottom">
        <p className="font-medium">Watch folder on the instrument PC</p>
        <p>
          The watcher only looks for files in this folder. Files saved anywhere
          else, such as a shared network drive, won't appear in Data Hub.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

export function InstrumentHeader({
  instrument,
  notifications,
  isAdmin = false,
}: {
  instrument: InstrumentDetail;
  /** Admins get the actions menu (edit, watcher, retire / reactivate). */
  isAdmin?: boolean;
  /**
   * Per-viewer notification state for this instrument. When omitted
   * (e.g. unauthenticated callers, or contexts that don't want to
   * surface the switch), the notifications control is hidden.
   */
  notifications?: {
    enabled: boolean;
    masterMuted: boolean;
  };
}) {
  const timeZone = useViewerTimeZone();
  // A pending instrument's page lists the watch folder and patterns in its
  // "Waiting for confirmation" card, so the header leaves them out.
  const showWatcherDetails = instrument.status !== "pending";
  const watchDirectory = showWatcherDetails
    ? (instrument.watcher?.watchDirectory ?? null)
    : null;
  const filePatterns = instrument.watcher?.filePatterns ?? [];
  const isManualUpload = instrument.watcher?.uploadMode === "manual";
  const retiredAt =
    instrument.status === "inactive" ? instrument.retiredAt : null;

  return (
    <div className="flex flex-col gap-2">
      <RecordInstrumentVisit
        displayName={instrument.displayName}
        instrumentId={instrument.id}
      />
      <Breadcrumb className="mb-2">
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
            <BreadcrumbPage>{instrument.displayName}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="font-semibold text-2xl tracking-tight">
              {instrument.displayName}
            </h1>
            <InstrumentBadge
              connection={instrument.connection}
              instrumentId={instrument.id}
              instrumentName={instrument.displayName}
              status={instrument.status}
              uploadMode={instrument.watcher?.uploadMode}
            />
          </div>

          {watchDirectory || retiredAt || isManualUpload ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-sm">
              {watchDirectory ? (
                <>
                  <WatchDirectory path={watchDirectory} />
                  {filePatterns.length > 0 ? (
                    <FilePatterns patterns={filePatterns} />
                  ) : null}
                </>
              ) : null}
              {isManualUpload ? <ManualUploadPill /> : null}
              {retiredAt ? (
                <>
                  {watchDirectory ? <span>·</span> : null}
                  <span className="flex items-center gap-1.5">
                    <span>Retired {formatDate(retiredAt, timeZone)}</span>
                    {instrument.retiredBy ? (
                      <span className="flex items-center gap-1.5">
                        <span>by</span>
                        <ActorLabel
                          actor={instrument.retiredBy}
                          nameClassName="font-medium text-foreground"
                        />
                      </span>
                    ) : null}
                  </span>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* Retired/pending instruments emit no new runs or outage alerts,
              so the subscribe pill would be a dead control — hide it outside
              the active state
              (matches `/settings/notifications`, which lists active only). */}
          {notifications && instrument.status === "active" ? (
            <InstrumentNotificationPill
              initialEnabled={notifications.enabled}
              instrumentId={instrument.id}
              masterMuted={notifications.masterMuted}
              size="sm"
            />
          ) : null}
          {isAdmin ? (
            <InstrumentActions instrument={instrument} variant="expanded" />
          ) : null}
        </div>
      </div>
    </div>
  );
}
