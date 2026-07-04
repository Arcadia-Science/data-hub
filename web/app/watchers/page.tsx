import type { Metadata } from "next/types";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { TableSkeleton } from "@/components/skeletons/table-skeleton";
import { WatchersView } from "@/components/watchers/watchers-view";
import { getWatcherList } from "@/lib/api/watchers";
import { auth } from "@/lib/auth";

const description = "Watcher agents reporting into Data Hub.";

export const metadata: Metadata = {
  title: "Watchers",
  description,
  openGraph: { title: "Watchers", description },
  twitter: { title: "Watchers", description },
};

export default async function WatchersPage() {
  const session = await auth();
  if (!session) {
    return (
      <SignInRequired callbackUrl="/watchers">
        Sign in to view watchers.
      </SignInRequired>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <div className="flex items-center justify-between">
        <h1 className="font-semibold text-2xl tracking-tight">Watchers</h1>
      </div>
      <Suspense
        fallback={<TableSkeleton ariaLabel="Loading watchers" columns={5} />}
      >
        <WatchersListSection />
      </Suspense>
    </div>
  );
}

async function WatchersListSection() {
  // Fetch all watchers in a single query and partition client-side. The total
  // count is small (typically <50), so this avoids two separate DB round-trips
  // and lets the toggle between active/deregistered be instant (no refetch).
  const allWatchers = await getWatcherList({ includeDeleted: true });

  const active = allWatchers.filter((w) => !w.deletedAt);
  const deregistered = allWatchers.filter((w) => w.deletedAt);

  return <WatchersView activeData={active} deregisteredData={deregistered} />;
}
