import { Badge } from "@/components/ui/badge";
import type { InstrumentDetail } from "@/lib/api/instruments";
import { Activity, ArrowLeft, Radio, WifiOff } from "lucide-react";
import Link from "next/link";

const statusBadge: Record<
  InstrumentDetail["status"],
  { label: string; variant: "default" | "outline" | "secondary" }
> = {
  active: { label: "Active", variant: "default" },
  pending: { label: "Pending", variant: "outline" },
  inactive: { label: "Inactive", variant: "secondary" },
};

type WatcherVariant = "online" | "offline" | "no_watcher";

const watcherBadge: Record<
  WatcherVariant,
  {
    label: string;
    variant: "default" | "destructive" | "outline";
    icon: typeof Activity;
  }
> = {
  online: { label: "Online", variant: "default", icon: Radio },
  offline: { label: "Offline", variant: "destructive", icon: WifiOff },
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
  const sb = statusBadge[instrument.status];
  const wv = getWatcherVariant(instrument);
  const wb = watcherBadge[wv];
  const WatcherIcon = wb.icon;

  return (
    <div className="flex flex-col gap-4">
      <Link
        href="/instruments"
        className="flex w-fit items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Back to instruments
      </Link>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {instrument.displayName}
          </h1>
          <Badge variant={sb.variant} className="text-[10px]">
            {sb.label}
          </Badge>
        </div>

        <div className="flex items-center gap-2">
          <Badge variant={wb.variant} className="gap-1 text-[10px]">
            <WatcherIcon className="size-3" />
            {wb.label}
            {instrument.watcherCount > 0 && (
              <span className="ml-0.5 font-mono">
                ({instrument.watchersOnline}/{instrument.watcherCount})
              </span>
            )}
          </Badge>
          <Badge variant="outline" className="font-mono text-[10px]">
            {instrument.runCount} {instrument.runCount === 1 ? "run" : "runs"}
          </Badge>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">
          {instrument.id}
        </span>
        {instrument.filePatterns && instrument.filePatterns.length > 0 && (
          <>
            <span className="text-muted-foreground">·</span>
            {instrument.filePatterns.map((p) => (
              <Badge
                key={p}
                variant="outline"
                className="font-mono text-[10px] font-normal"
              >
                {p}
              </Badge>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
