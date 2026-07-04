import { RunsTableSkeleton } from "@/components/dashboard/runs-table";
import { Skeleton } from "@/components/ui/skeleton";

export default function InstrumentDetailLoading() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <div className="flex flex-col gap-2">
        <Skeleton className="mb-2 h-4 w-56" />
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-7 w-28" />
        </div>
        <Skeleton className="h-4 w-40" />
      </div>
      <RunsTableSkeleton />
    </div>
  );
}
