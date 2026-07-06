import { WatcherDetailTabsSkeleton } from "@/components/watchers/watcher-detail-tabs";
import { WatcherHeaderSkeleton } from "@/components/watchers/watcher-header";

export default function WatcherDetailLoading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <WatcherHeaderSkeleton />
      <WatcherDetailTabsSkeleton />
    </div>
  );
}
