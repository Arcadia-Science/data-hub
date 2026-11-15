import { permanentRedirect } from "next/navigation";
import type { Metadata } from "next/types";
import {
  firstQueryValue,
  requireWatcherPageSession,
} from "@/lib/watchers/load-page";
import { legacyWatchersRedirect } from "@/lib/watchers/routes";

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// This route only redirects, so nothing shows in a link preview.
export const metadata: Metadata = { title: "Watchers" };

/**
 * The old watcher list. Admins find it in Settings › Watchers, on the
 * Deregistered tab when the old URL asked for it. Members have no list, so they
 * go to the instruments. Both redirects are permanent. A signed-out visitor
 * goes to sign-in first, and comes back here afterwards.
 */
export default async function WatchersRedirectPage({ searchParams }: Props) {
  const session = await requireWatcherPageSession();
  const query = await searchParams;

  permanentRedirect(
    legacyWatchersRedirect({
      isAdmin: session.user.isAdmin === true,
      tab: firstQueryValue(query.tab),
    })
  );
}
