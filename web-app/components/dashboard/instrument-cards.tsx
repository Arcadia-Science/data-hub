import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getInstrumentSummaries,
  type InstrumentSummary,
} from "@/lib/api/dashboard";
import { formatRelativeTime } from "@/lib/utils";
import { Activity, Radio, Upload, WifiOff } from "lucide-react";

const watcherBadge: Record<
  InstrumentSummary["watcherStatus"],
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

export async function InstrumentCards() {
  const summaries = await getInstrumentSummaries();

  if (summaries.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
        No instruments configured yet.
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {summaries.map((s) => {
        const wb = watcherBadge[s.watcherStatus];
        const WatcherIcon = wb.icon;
        return (
          <Card key={s.id}>
            <CardHeader>
              <div className="flex items-start justify-between gap-2">
                <CardTitle className="text-sm font-medium">
                  {s.displayName}
                </CardTitle>
                <Badge
                  variant={wb.variant}
                  className="shrink-0 gap-1 text-[10px]"
                >
                  <WatcherIcon className="size-3" />
                  {wb.label}
                </Badge>
              </div>
              <CardDescription className="text-xs">
                <span className="font-mono">{s.runCount}</span>{" "}
                {s.runCount === 1 ? "run" : "runs"}
                {s.lastRunAt && (
                  <> &middot; last {formatRelativeTime(s.lastRunAt)}</>
                )}
              </CardDescription>
              {s.filesPendingUpload > 0 && (
                <Badge
                  variant="secondary"
                  className="mt-1 w-fit gap-1 text-[10px]"
                >
                  <Upload className="size-3" />
                  {s.filesPendingUpload} pending upload
                </Badge>
              )}
            </CardHeader>
          </Card>
        );
      })}
    </div>
  );
}

export function InstrumentCardsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i}>
          <CardHeader>
            <div className="flex items-start justify-between gap-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-5 w-16" />
            </div>
            <Skeleton className="mt-1.5 h-3 w-24" />
          </CardHeader>
        </Card>
      ))}
    </div>
  );
}
