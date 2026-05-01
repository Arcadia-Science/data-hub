import { WatchersView } from "@/components/watchers/watchers-view";
import { getWatcherList } from "@/lib/api/watchers";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import type { Metadata } from "next/types";

export const metadata: Metadata = {
  title: "Watchers",
};

export default async function WatchersPage() {
  const session = await auth();
  if (!session) redirect("/login");

  // Fetch all watchers in a single query and partition client-side. The total
  // count is small (typically <50), so this avoids two separate DB round-trips
  // and lets the toggle between active/deregistered be instant (no refetch).
  const allWatchers = await getWatcherList({ includeDeleted: true });

  const active = allWatchers.filter((w) => !w.deletedAt);
  const deregistered = allWatchers.filter((w) => w.deletedAt);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Watchers</h1>
      </div>
      <WatchersView activeData={active} deregisteredData={deregistered} />
    </div>
  );
}
