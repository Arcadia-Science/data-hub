import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { TableSkeleton } from "@/components/skeletons/table-skeleton";
import { Skeleton } from "@/components/ui/skeleton";

export default function WatchersLoading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <PageHeaderSkeleton />
      <Skeleton className="h-8 w-64" />
      <TableSkeleton ariaLabel="Loading watchers" columns={5} />
    </div>
  );
}
