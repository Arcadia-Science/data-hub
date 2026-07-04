import { TableSkeleton } from "@/components/skeletons/table-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

export default function RunDetailLoading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <div className="flex flex-col gap-2">
        <Skeleton className="mb-2 h-4 w-72" />
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-72" />
          <Skeleton className="h-8 w-40" />
        </div>
        <Skeleton className="h-4 w-52" />
      </div>
      <Skeleton className="h-40 w-full rounded-lg" />
      <TableSkeleton ariaLabel="Loading files" columns={4} rows={6} />
    </div>
  );
}
