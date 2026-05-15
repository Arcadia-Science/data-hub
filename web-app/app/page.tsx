import { SignInRequired } from "@/components/auth/sign-in-required";
import { DashboardStatsCards } from "@/components/dashboard/dashboard-stats";
import { RunsTable } from "@/components/dashboard/runs-table";
import { RunsToolbar } from "@/components/dashboard/runs-toolbar";
import { InstrumentsTable } from "@/components/instruments/instruments-table";
import { RunBulkActionBar } from "@/components/instruments/runs-table/run-bulk-action-bar";
import { RunSelectionProvider } from "@/components/instruments/runs-table/run-selection-provider";
import { PaginationNav } from "@/components/pagination-nav";
import {
  TablePendingBoundary,
  TablePendingProvider,
} from "@/components/table-pending";
import { getDashboardStats, getInstruments } from "@/lib/api/dashboard";
import { buildRunListQuery } from "@/lib/api/instrument-runs";
import { getRecentActiveInstrumentsForDashboard } from "@/lib/api/instruments";
import { auth } from "@/lib/auth";
import { dashboardParamsCache, hasActiveFilters } from "@/lib/search-params";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { Metadata } from "next/types";

export const metadata: Metadata = {
  title: "Data Hub",
};

function last24hISOString(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
}

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

  // Convert empty array to undefined so buildRunListQuery skips the filter
  // and returns runs across all instruments (the unfiltered default).
  const instrumentIds =
    params.instrument_id.length > 0 ? params.instrument_id : undefined;

  // When no explicit date filter is set, default to a 24-hour lookback. This
  // matches the "Last 24 hours" label surfaced by the dashboard's
  // RunsDateFilter and keeps the initial payload bounded.
  const defaultDateFrom = last24hISOString();

  const currentUserId = session.user?.id ?? null;

  // Surface the three most recently active instruments on the dashboard. The
  // focused query returns just those rows + the active total used by the
  // "View all N" link, so we don't fetch the entire fleet to discard the
  // long tail in JS. Pending/inactive instruments are filtered server-side.
  const RECENT_INSTRUMENTS_LIMIT = 3;

  // Fetch the toolbar instrument list, the dashboard instrument summary, the
  // filtered run page, and the summary stats in parallel since none depend on
  // the others.
  const [instruments, recentInstruments, runResult, stats] = await Promise.all([
    getInstruments(),
    getRecentActiveInstrumentsForDashboard(RECENT_INSTRUMENTS_LIMIT),
    buildRunListQuery({
      instrumentId: instrumentIds,
      search: params.search || undefined,
      dateFrom: params.date_from ?? defaultDateFrom,
      dateTo: params.date_to ?? undefined,
      page: params.page,
      perPage: params.per_page,
      includeDeleted: params.include_deleted,
    }),
    getDashboardStats(currentUserId),
  ]);

  const { rows: recentActiveInstruments, totalActive: totalActiveInstruments } =
    recentInstruments;

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
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 p-6 2xl:w-7xl">
      <DashboardStatsCards stats={stats} />

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium tracking-tight">Instruments</h2>
        <InstrumentsTable
          data={recentActiveInstruments}
          footer={
            <Link
              href="/instruments"
              className="flex items-center justify-center gap-1.5 px-4 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              View all {totalActiveInstruments} instruments
              <ArrowRight className="size-3.5" />
            </Link>
          }
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium tracking-tight">Recent runs</h2>
        <RunSelectionProvider>
          <TablePendingProvider>
            <RunsToolbar instruments={instruments} />
            <RunBulkActionBar />
            <TablePendingBoundary>
              <RunsTable
                data={runResult.data}
                hasFilters={hasFilters}
                totalCount={runResult.pagination.total}
                pendingUploadCount={pendingUploadCount}
                unattributedCount={unattributedCount}
                ranByYouCount={ranByYouCount}
              />
            </TablePendingBoundary>
            <PaginationNav
              page={runResult.pagination.page}
              totalPages={runResult.pagination.total_pages}
              pageParam="page"
            />
          </TablePendingProvider>
        </RunSelectionProvider>
      </section>
    </div>
  );
}
