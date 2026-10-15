import { Skeleton } from "@/components/ui/skeleton";

// Separate from the chart so the tabs can show it while the chart library
// loads, without importing that library themselves.
export function HeartbeatChartSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-background p-4 dark:bg-muted">
      <Skeleton className="h-64 w-full" />
      <Skeleton className="mx-auto h-3 w-48" />
      <Skeleton className="mt-2 h-6 w-full" />
    </div>
  );
}
