import { ArrowRight, ExternalLink, History, Radio } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { DocsLink } from "@/components/docs-link";
import { EmptyState } from "@/components/empty-state";
import { LinkTabs } from "@/components/link-tabs";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  NOTICE_LINK_CLASSNAME,
  WatcherNotice,
} from "@/components/watchers/watcher-notice";
import { WatcherPageMenu } from "@/components/watchers/watcher-page-menu";
import { WatcherStatusBadge } from "@/components/watchers/watcher-status-badge";
import { WatcherSummaryStrip } from "@/components/watchers/watcher-summary-strip";
import { readInstrumentConfigFields } from "@/lib/api/watcher-config/from-yaml";
import { ADD_INSTRUMENT_DOCS_URL } from "@/lib/docs";
import { getViewerTimeZone } from "@/lib/viewer-timezone";
import type { WatcherPageData } from "@/lib/watchers/load-page";
import { describeDeregistration } from "@/lib/watchers/registrations";
import {
  WATCHER_TABS,
  type WatcherTab,
  watcherPageHref,
} from "@/lib/watchers/routes";

function WatcherBreadcrumb({
  instrumentId,
  instrumentName,
}: {
  instrumentId: string;
  instrumentName: string;
}) {
  return (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link href="/">Home</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link href="/instruments">Instruments</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link href={`/instruments/${encodeURIComponent(instrumentId)}`}>
              {instrumentName}
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>Watcher</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

function SetupGuideLink({ children }: { children: ReactNode }) {
  return (
    <DocsLink className={NOTICE_LINK_CLASSNAME} href={ADD_INSTRUMENT_DOCS_URL}>
      {children}
      <ExternalLink aria-hidden="true" className="size-3.5" />
      <span className="sr-only">(opens in a new tab)</span>
    </DocsLink>
  );
}

function PastWatcherNotice({
  data,
  tab,
  isAdmin,
  timeZone,
}: {
  data: WatcherPageData;
  tab: WatcherTab;
  isAdmin: boolean;
  timeZone: string;
}) {
  const { selection, instrument } = data;
  const past = selection.selected;
  if (!past) {
    return null;
  }
  // A way forward: back to the current watcher, or, with none, a new one for
  // admins to connect.
  let action: ReactNode = null;
  if (selection.current) {
    action = (
      <Link
        className={NOTICE_LINK_CLASSNAME}
        href={watcherPageHref(instrument.id, { tab })}
      >
        Go to the current watcher
        <ArrowRight aria-hidden="true" className="size-3.5" />
      </Link>
    );
  } else if (isAdmin) {
    action = <SetupGuideLink>Connect a new watcher</SetupGuideLink>;
  }
  return (
    <WatcherNotice
      actions={action}
      icon={History}
      title="You're viewing a past watcher"
    >
      {describeDeregistration(past, timeZone)} Its activity, health, and
      settings are read-only.
    </WatcherNotice>
  );
}

function NoWatcherYet({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <EmptyState className="w-full" icon={Radio}>
        No watcher has connected yet.
      </EmptyState>
      {isAdmin ? (
        <p className="text-sm">
          <SetupGuideLink>Connect a watcher</SetupGuideLink>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Everything the three watcher sub-tabs share: the breadcrumb, the heading with
 * the watcher's badge, the admin menu, the past-watcher notice, the summary
 * strip with its switcher, and the sub-tab links. `children` is the open
 * tab's content.
 *
 * Each page renders this itself instead of the route's `layout.tsx` doing it,
 * because the frame depends on `?watcher=`: a layout doesn't receive search
 * params and isn't rendered again when only they change.
 *
 * With no registration at all there is nothing to show, so it renders the
 * heading and an empty state instead of the strip, the tabs and `children`.
 */
export async function WatcherFrame({
  data,
  tab,
  isAdmin,
  children,
}: {
  data: WatcherPageData;
  tab: WatcherTab;
  isAdmin: boolean;
  children: ReactNode;
}) {
  const { instrument, selection, watcher } = data;
  const timeZone = await getViewerTimeZone();
  const isPast = selection.isPast;
  // The sub-tab links keep `?watcher=` when the URL had it.
  const watcherId = selection.requested
    ? (selection.selected?.id ?? null)
    : null;

  return (
    <div className="flex min-w-0 flex-col gap-5">
      <WatcherBreadcrumb
        instrumentId={instrument.id}
        instrumentName={instrument.displayName}
      />

      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h1 className="font-semibold text-2xl tracking-tight">
              Watcher for {instrument.displayName}
            </h1>
            {watcher ? (
              <WatcherStatusBadge
                lastOnlineAt={watcher.lastHeartbeatAt}
                // A past watcher reads Deregistered whatever it reported last.
                reason={isPast ? null : watcher.statusReason}
                status={isPast ? "deregistered" : watcher.effectiveStatus}
              />
            ) : null}
          </div>
        </div>
        {isAdmin && watcher && !isPast ? (
          <WatcherPageMenu hostname={watcher.hostname} watcherId={watcher.id} />
        ) : null}
      </div>

      {isPast ? (
        <PastWatcherNotice
          data={data}
          isAdmin={isAdmin}
          tab={tab}
          timeZone={timeZone}
        />
      ) : null}

      {watcher ? (
        <>
          <WatcherSummaryStrip
            instrumentId={instrument.id}
            isPast={isPast}
            latestVersion={data.latestVersion}
            registrations={selection.registrations}
            sharedComputerWith={data.sharedComputerWith}
            showSwitcher={selection.showSwitcher}
            tab={tab}
            uploadMode={
              readInstrumentConfigFields(watcher.configYaml).uploadMode
            }
            watcher={watcher}
          />
          <LinkTabs
            current={tab}
            label="Watcher sections"
            tabs={WATCHER_TABS.map(({ key, label }) => ({
              key,
              label,
              href: watcherPageHref(instrument.id, { tab: key, watcherId }),
            }))}
          />
          {children}
        </>
      ) : (
        <NoWatcherYet isAdmin={isAdmin} />
      )}
    </div>
  );
}
