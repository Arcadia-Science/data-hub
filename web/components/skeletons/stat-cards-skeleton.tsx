import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// Placeholder for `DashboardStatsCards`. Reuses the same `Card` shell and grid
// so the four metric cards stream in without reflowing the dashboard header.
export function StatCardsSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading stats"
      className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4"
      role="status"
    >
      {Array.from({ length: 4 }).map((_, i) => (
        <Card className="gap-2 py-4" key={i} size="sm">
          <div className="px-4">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="mt-2 h-7 w-16" />
            <Skeleton className="mt-2 h-3 w-36" />
          </div>
        </Card>
      ))}
    </div>
  );
}
