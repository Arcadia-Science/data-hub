import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { WatcherConfig } from "@/components/watchers/watcher-config";
import { WatcherFrame } from "@/components/watchers/watcher-frame";
import {
  getWatcherConfigState,
  listConfigRevisions,
} from "@/lib/api/watcher-config/revisions";
import type { WatcherDetail } from "@/lib/api/watchers";
import {
  firstQueryValue,
  loadWatcherPage,
  requireWatcherPageSession,
} from "@/lib/watchers/load-page";

interface Props {
  params: Promise<{ instrumentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function WatcherSettingsSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading settings"
      className="flex flex-col gap-5"
      role="status"
    >
      <Skeleton className="h-64 w-full rounded-xl" />
      <Skeleton className="h-40 w-full rounded-xl" />
    </div>
  );
}

/**
 * The watcher page's Settings tab. It reads the same for a pending instrument
 * as for an active one: it needs the watcher, not the instrument's status.
 */
export default async function WatcherSettingsPage({
  params,
  searchParams,
}: Props) {
  const session = await requireWatcherPageSession();
  const { instrumentId } = await params;
  const query = await searchParams;
  // Before any Suspense boundary, so an unknown `?watcher=` is a real 404.
  const data = await loadWatcherPage(instrumentId, query.watcher);
  const isAdmin = session.user.isAdmin === true;

  return (
    <WatcherFrame data={data} isAdmin={isAdmin} tab="settings">
      {data.watcher ? (
        <Suspense fallback={<WatcherSettingsSkeleton />}>
          <WatcherSettingsSection
            focusWatchFolder={
              firstQueryValue(query.focus) === "watch_directory"
            }
            isAdmin={isAdmin}
            viewerUserId={session.user.id}
            watcher={data.watcher}
          />
        </Suspense>
      ) : null}
    </WatcherFrame>
  );
}

async function WatcherSettingsSection({
  watcher,
  isAdmin,
  viewerUserId,
  focusWatchFolder,
}: {
  watcher: WatcherDetail;
  isAdmin: boolean;
  viewerUserId: string;
  focusWatchFolder: boolean;
}) {
  const history = await listConfigRevisions(watcher.id);
  const state = await getWatcherConfigState(watcher, history);
  return (
    <WatcherConfig
      focusField={focusWatchFolder ? "watch_directory" : undefined}
      history={history}
      isAdmin={isAdmin}
      state={state}
      viewerUserId={viewerUserId}
      watcher={watcher}
    />
  );
}
