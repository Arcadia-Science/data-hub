import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import type { InstrumentDetail } from "@/lib/api/instruments";
import { Activity, Radio, WifiOff } from "lucide-react";
import Link from "next/link";

type WatcherVariant = "online" | "offline" | "no_watcher";

const watcherBadge: Record<
  WatcherVariant,
  {
    label: string;
    variant: "default" | "destructive" | "outline";
    icon: typeof Activity;
  }
> = {
  online: { label: "Watcher Online", variant: "default", icon: Radio },
  offline: { label: "Watcher Offline", variant: "destructive", icon: WifiOff },
  no_watcher: { label: "No Watcher", variant: "outline", icon: WifiOff },
};

// An instrument is "online" if at least one watcher is actively heartbeating.
// Registered watchers that have gone silent are treated as "offline".
function getWatcherVariant(instrument: InstrumentDetail): WatcherVariant {
  if (instrument.watcherCount === 0) return "no_watcher";
  return instrument.watchersOnline > 0 ? "online" : "offline";
}

export function InstrumentHeader({
  instrument,
}: {
  instrument: InstrumentDetail;
}) {
  const wv = getWatcherVariant(instrument);
  const wb = watcherBadge[wv];
  const WatcherIcon = wb.icon;

  return (
    <div className="flex flex-col gap-2">
      <Breadcrumb className="mb-2">
        <BreadcrumbList>
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

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {instrument.displayName}
          </h1>
        </div>

        <div className="flex items-center gap-2">
          {instrument.activeWatcherId ? (
            <Link href={`/watchers/${instrument.activeWatcherId}`}>
              <Badge
                variant={wb.variant}
                className="gap-1 px-2 py-3 text-xs transition-colors hover:opacity-80"
              >
                <WatcherIcon className="size-3" />
                {wb.label}
              </Badge>
            </Link>
          ) : (
            <Badge variant={wb.variant} className="gap-1 px-2 py-3 text-xs">
              <WatcherIcon className="size-3" />
              {wb.label}
            </Badge>
          )}
          <Badge variant="outline" className="px-2 py-3 font-mono text-xs">
            {instrument.runCount} {instrument.runCount === 1 ? "run" : "runs"}
          </Badge>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-muted-foreground">
          {instrument.id}
        </span>
      </div>
    </div>
  );
}
