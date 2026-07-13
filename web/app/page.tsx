import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { Metadata } from "next/types";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import {
  DashboardStatsCards,
  StatCardsSkeleton,
} from "@/components/dashboard/dashboard-stats";
import {
  DashboardRunsSkeleton,
  RunsTable,
} from "@/components/dashboard/runs-table";
import { RunsToolbar } from "@/components/dashboard/runs-toolbar";
import {
  InstrumentsTable,
  InstrumentsTableSkeleton,
} from "@/components/instruments/instruments-table";
import { RunBulkActionBar } from "@/components/instruments/runs-table/run-bulk-action-bar";
import { RunSelectionProvider } from "@/components/instruments/runs-table/run-selection-provider";
import { PaginationNav } from "@/components/pagination-nav";
import {
  TablePendingBoundary,
  TablePendingProvider,
} from "@/components/table-pending";
import {
  getDashboardStats,
  getInstruments,
  getTopAttributorThisWeek,
} from "@/lib/api/dashboard";
import {
  buildRunListQuery,
  getRanByFilterOptions,
} from "@/lib/api/instrument-runs";
import { getRecentActiveInstrumentsForDashboard } from "@/lib/api/instruments";
import { auth } from "@/lib/auth";
import { startOfTodayISO } from "@/lib/date";
import { dashboardParamsCache, hasActiveFilters } from "@/lib/search-params";
import { getViewerTimeZone } from "@/lib/viewer-timezone";

type DashboardParams = Awaited<ReturnType<typeof dashboardParamsCache.parse>>;

const description =
  "A central hub for your lab's instruments, runs, and files.";

export const metadata: Metadata = {
  description,
  openGraph: { title: "Data Hub", description },
  twitter: { title: "Data Hub", description },
};

const RECENT_INSTRUMENTS_LIMIT = 3;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  // Render the page metadata (title) for unauthenticated visitors so links
  // shared into Notion / Slack still unfurl with a useful title; show a
  // sign-in CTA in the body instead of leaking data. Real users come back
  // here after the Google flow via `callbackUrl`.
  if (!session) {
    return (
      <SignInRequired callbackUrl="/">
        Sign in to view your dashboard.
      </SignInRequired>
    );
  }

  const params = dashboardParamsCache.parse(await searchParams);
  const currentUserId = session.user?.id ?? null;

  // Each section fetches its own data behind a Suspense boundary so the static
  // shell (headings) paints immediately and the three data blocks stream in
  // independently — a slow runs query no longer holds up the stats cards.
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 p-6 2xl:w-7xl">
      <Suspense fallback={<StatCardsSkeleton />}>
        <DashboardStatsSection />
      </Suspense>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-lg tracking-tight">Instruments</h2>
        <Suspense
          fallback={
            <InstrumentsTableSkeleton
              footerLabel="View all instruments"
              rows={3}
              withFooter
              withNotifications={false}
            />
          }
        >
          <DashboardInstrumentsSection />
        </Suspense>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-lg tracking-tight">Recent runs</h2>
        <Suspense fallback={<DashboardRunsSkeleton />}>
          <DashboardRunsSection currentUserId={currentUserId} params={params} />
        </Suspense>
      </section>
    </div>
  );
}

async function DashboardStatsSection() {
  // The fleet stats and the leaderboard card are independent aggregates.
  const [stats, topAttributor] = await Promise.all([
    getDashboardStats(),
    getTopAttributorThisWeek(),
  ]);
  return <DashboardStatsCards stats={stats} topAttributor={topAttributor} />;
}

async function DashboardInstrumentsSection() {
  // Surface the three most recently active instruments. The focused query
  // returns just those rows + the active total used by the "View all N" link,
  // so we don't fetch the entire fleet to discard the long tail in JS.
  const { rows, totalActive } = await getRecentActiveInstrumentsForDashboard(
    RECENT_INSTRUMENTS_LIMIT
  );

  return (
    <InstrumentsTable
      data={rows}
      footer={
        <Link
          className="flex items-center justify-center gap-1.5 px-4 py-2.5 text-muted-foreground text-sm transition-colors hover:bg-muted/50 hover:text-foreground"
          href="/instruments"
        >
          View all {totalActive} instruments
          <ArrowRight className="size-3.5" />
        </Link>
      }
    />
  );
}

async function DashboardRunsSection({
  currentUserId,
  params,
}: {
  currentUserId: string | null;
  params: DashboardParams;
}) {
  // Convert empty array to undefined so buildRunListQuery skips the filter
  // and returns runs across all instruments (the unfiltered default).
  const instrumentIds =
    params.instrument_id.length > 0 ? params.instrument_id : undefined;

  // When no explicit date filter is set, default to the start of today in the
  // viewer's timezone. This matches the "Today" label surfaced by the
  // dashboard's RunsDateFilter and keeps the initial payload bounded.
  const defaultDateFrom = startOfTodayISO(await getViewerTimeZone());

  // The toolbar instrument list, the fleet-wide attributor options, and the
  // filtered run page are all independent. Only active instruments are useful
  // filter targets on the dashboard.
  const [instruments, ranByUsers, runResult] = await Promise.all([
    getInstruments(true),
    getRanByFilterOptions(),
    buildRunListQuery({
      instrumentId: instrumentIds,
      search: params.search || undefined,
      dateFrom: params.date_from ?? defaultDateFrom,
      dateTo: params.date_to ?? undefined,
      page: params.page,
      perPage: params.per_page,
      includeDeleted: params.include_deleted,
      ranBy: params.ran_by ?? undefined,
      statuses: params.status.length > 0 ? params.status : undefined,
    }),
  ]);

  // Current user pinned as "You" at the top (if they've attributed anything),
  // then other attributors by display name, then the "Unattributed" sentinel —
  // matching the per-instrument page's dropdown.
  const meOption = currentUserId
    ? ranByUsers.find((u) => u.userId === currentUserId)
    : undefined;
  const ranByOptions = [
    ...(meOption ? [{ value: meOption.userId, label: "You" }] : []),
    ...ranByUsers
      .filter((u) => u.userId !== currentUserId)
      .map((u) => ({ value: u.userId, label: u.displayName })),
    { value: "unattributed", label: "Unattributed" },
  ];

  const hasFilters = hasActiveFilters(params);
  const pendingUploadCount = runResult.data.filter(
    (row) => row.files_pending_upload > 0
  ).length;
  const unattributedCount = runResult.data.filter(
    (row) => row.attributions.length === 0
  ).length;
  const ranByYouCount = currentUserId
    ? runResult.data.filter((row) =>
        row.attributions.some((a) => a.userId === currentUserId)
      ).length
    : 0;

  return (
    <RunSelectionProvider>
      <TablePendingProvider>
        <div className="flex flex-col gap-3">
          <RunsToolbar dateDefaultPreset="today" instruments={instruments} />
          <RunBulkActionBar />
          <TablePendingBoundary>
            <RunsTable
              data={runResult.data}
              hasFilters={hasFilters}
              pendingUploadCount={pendingUploadCount}
              ranByOptions={ranByOptions}
              ranByYouCount={ranByYouCount}
              totalCount={runResult.pagination.total}
              unattributedCount={unattributedCount}
            />
          </TablePendingBoundary>
          <PaginationNav
            page={runResult.pagination.page}
            pageParam="page"
            totalPages={runResult.pagination.total_pages}
          />
        </div>
      </TablePendingProvider>
    </RunSelectionProvider>
  );
}
