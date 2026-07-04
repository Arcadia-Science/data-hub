import { Skeleton } from "@/components/ui/skeleton";
import { HeartbeatChartSkeleton } from "@/components/watchers/heartbeat-chart";

export default function WatcherDetailLoading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-48" />
      </div>
      <Skeleton className="h-9 w-72" />
      <HeartbeatChartSkeleton />
    </div>
  );
}
