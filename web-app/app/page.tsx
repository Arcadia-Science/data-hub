import {
  InstrumentCards,
  InstrumentCardsSkeleton,
} from "@/components/dashboard/instrument-cards";
import { RunsTable } from "@/components/dashboard/runs-table";
import { RunsToolbar } from "@/components/dashboard/runs-toolbar";
import { RunBulkActionBar } from "@/components/instruments/runs-table/run-bulk-action-bar";
import { RunSelectionProvider } from "@/components/instruments/runs-table/run-selection-provider";
import { PaginationNav } from "@/components/pagination-nav";
import {
  TablePendingBoundary,
  TablePendingProvider,
} from "@/components/table-pending";
import { getInstruments } from "@/lib/api/dashboard";
import { buildRunListQuery } from "@/lib/api/instrument-runs";
import { auth } from "@/lib/auth";
import { dashboardParamsCache, hasActiveFilters } from "@/lib/search-params";
import { redirect } from "next/navigation";
import type { Metadata } from "next/types";
import { Suspense } from "react";

export const metadata: Metadata = {
  title: "Dashboard",
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

  // When no date_from is in the URL, default to a 24-hour lookback using a
  // full ISO timestamp so the cutoff is timezone-agnostic. A bare date string
  // like "2026-04-15" would be parsed as midnight UTC, which can be "tomorrow"
  // relative to the user's local timezone — hiding today's runs on first load.
  const defaultDateFrom = last24hISOString();

  // Fetch the instrument list (for the toolbar combobox) and the filtered run
  // page in parallel since neither depends on the other's result.
  const [instruments, runResult] = await Promise.all([
    getInstruments(),
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
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <Suspense fallback={<InstrumentCardsSkeleton />}>
        <InstrumentCards />
      </Suspense>

      <RunSelectionProvider>
        <TablePendingProvider>
          <RunsToolbar instruments={instruments} />
          <RunBulkActionBar />
          <TablePendingBoundary>
            <RunsTable data={runResult.data} hasFilters={hasFilters} />
          </TablePendingBoundary>
          <PaginationNav
            page={runResult.pagination.page}
            totalPages={runResult.pagination.total_pages}
            pageParam="page"
          />
          {runResult.data.length > 0 ? (
            <div className="flex items-center justify-end text-xs text-muted-foreground">
              <p>
                <span className="tabular-nums">{pendingUploadCount}</span>{" "}
                pending upload ·{" "}
                <span className="tabular-nums">{unattributedCount}</span>{" "}
                unattributed ·{" "}
                <span className="tabular-nums">{ranByYouCount}</span> ran by you
              </p>
            </div>
          ) : null}
        </TablePendingProvider>
      </RunSelectionProvider>
    </div>
  );
}
