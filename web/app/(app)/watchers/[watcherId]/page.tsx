import { notFound, permanentRedirect } from "next/navigation";
import type { Metadata } from "next/types";
import { findWatcherIncludingDeleted } from "@/lib/api/watchers";
import {
  firstQueryValue,
  requireWatcherPageSession,
} from "@/lib/watchers/load-page";
import { isWatcherId, legacyWatcherRedirect } from "@/lib/watchers/routes";

interface Props {
  params: Promise<{ watcherId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// This route only redirects, so nothing shows in a link preview.
export const metadata: Metadata = { title: "Watcher" };

/**
 * The old watcher page. A watcher belongs to its instrument now, so this
 * redirects, permanently, to the instrument's watcher page: the sub-tab that
 * `?tab=` names, and `?watcher=` for a deregistered watcher. Bookmarks and
 * links people have already shared keep working.
 */
export default async function WatcherRedirectPage({
  params,
  searchParams,
}: Props) {
  await requireWatcherPageSession();

  const { watcherId } = await params;
  const query = await searchParams;

  // A string that isn't a UUID can't be a watcher, and the database would
  // refuse to compare it with the ID column.
  const watcher = isWatcherId(watcherId)
    ? await findWatcherIncludingDeleted(watcherId)
    : null;
  if (!watcher) {
    notFound();
  }

  permanentRedirect(
    legacyWatcherRedirect({
      instrumentId: watcher.instrumentId,
      watcherId: watcher.id,
      deregistered: watcher.deletedAt !== null,
      tab: firstQueryValue(query.tab),
    })
  );
}
