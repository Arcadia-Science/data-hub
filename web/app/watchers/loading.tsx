import { WatchersViewSkeleton } from "@/components/watchers/watchers-view";

export default function WatchersLoading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <div className="flex items-center justify-between">
        <h1 className="font-semibold text-2xl tracking-tight">Watchers</h1>
      </div>
      <WatchersViewSkeleton />
    </div>
  );
}
