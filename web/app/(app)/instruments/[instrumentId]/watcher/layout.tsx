import { notFound } from "next/navigation";
import type { Metadata } from "next/types";
import type { ReactNode } from "react";
import { RecordInstrumentVisit } from "@/components/recent-instrument-visit";
import { getInstrumentById } from "@/lib/api/instruments";
import { WATCHER_DESCRIPTION } from "@/lib/watchers/copy";
import { requireWatcherPageSession } from "@/lib/watchers/load-page";

interface Props {
  children: ReactNode;
  params: Promise<{ instrumentId: string }>;
}

export async function generateMetadata({
  params,
}: Pick<Props, "params">): Promise<Metadata> {
  const { instrumentId } = await params;
  const instrument = await getInstrumentById(instrumentId);
  // The root layout's template adds " | Data Hub".
  const title = `${instrument?.displayName ?? instrumentId} · Watcher`;
  return {
    title,
    description: WATCHER_DESCRIPTION,
    openGraph: { title, description: WATCHER_DESCRIPTION },
    twitter: { title, description: WATCHER_DESCRIPTION },
  };
}

/**
 * The three watcher pages (Activity, Health, Settings) share this layout. It
 * holds what doesn't depend on `?watcher=`: the sign-in guard, the page width,
 * the page title, and the visit that keeps the instrument in the sidebar. The
 * heading, summary strip and tabs are `WatcherFrame`, which each page renders,
 * because a layout can't read search params.
 */
export default async function WatcherLayout({ children, params }: Props) {
  // The proxy sends a signed-out visitor to sign-in before this runs. This is
  // the guard for a cookie that no longer has a session behind it.
  await requireWatcherPageSession();

  const { instrumentId } = await params;
  const instrument = await getInstrumentById(instrumentId);
  if (!instrument) {
    notFound();
  }

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 px-6 pt-3.5 pb-6 2xl:w-6xl">
      {/* `pt-3.5` centers the breadcrumbs on the sidebar's "Navigation" label. */}
      <RecordInstrumentVisit
        displayName={instrument.displayName}
        instrumentId={instrument.id}
      />
      {children}
    </div>
  );
}
