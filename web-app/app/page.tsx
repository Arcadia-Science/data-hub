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
import { getInstruments } from "@/lib/api/dashboard";
import { buildRunListQuery } from "@/lib/api/instrument-runs";
import { getInstrumentListWithCounts } from "@/lib/api/instruments";
import { auth } from "@/lib/auth";
import { dashboardParamsCache, hasActiveFilters } from "@/lib/search-params";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";
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
  if (!session) redirect("/login");

  const params = dashboardParamsCache.parse(await searchParams);

  // Convert empty array to undefined so buildRunListQuery skips the filter
  // and returns runs across all instruments (the unfiltered default).
  const instrumentIds =
    params.instrument_id.length > 0 ? params.instrument_id : undefined;

  // When no explicit date filter is set, default to a 24-hour lookback. This
  // matches the "Last 24 hours" label surfaced by the dashboard's
  // RunsDateFilter and keeps the initial payload bounded.
  const defaultDateFrom = last24hISOString();

  // Fetch the toolbar instrument list, the dashboard instrument summary, and
  // the filtered run page in parallel since none depend on the others.
  const [instruments, instrumentsWithCounts, runResult] = await Promise.all([
    getInstruments(),
    getInstrumentListWithCounts(),
    buildRunListQuery({
      instrumentId: instrumentIds,
      search: params.search || undefined,
      dateFrom: params.date_from ?? defaultDateFrom,
      dateTo: params.date_to ?? undefined,
      page: params.page,
      perPage: params.per_page,
      includeDeleted: params.include_deleted,
    }),
  ]);

  // Surface the three most recently active instruments. Pending/inactive
  // instruments are filtered out so the dashboard reflects the live fleet;
  // a "View all" link routes to the full management page.
  const recentActiveInstruments = instrumentsWithCounts
    .filter((i) => i.status === "active")
    .sort(
      (a, b) => (b.lastRunAt?.getTime() ?? 0) - (a.lastRunAt?.getTime() ?? 0)
    )
    .slice(0, 3);
  const totalActiveInstruments = instrumentsWithCounts.filter(
    (i) => i.status === "active"
  ).length;

  const hasFilters = hasActiveFilters(params);
  const currentUserId = session.user?.id ?? null;
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
    <div className="mx-auto flex max-w-7xl flex-col gap-8 p-6">
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
