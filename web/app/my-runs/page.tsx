import type { Metadata } from "next/types";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import {
  MyRunsStatsCards,
  MyRunsStatsCardsSkeleton,
} from "@/components/dashboard/dashboard-stats";
import {
  DashboardRunsSkeleton,
  RunsTable,
} from "@/components/dashboard/runs-table";
import { RunsToolbar } from "@/components/dashboard/runs-toolbar";
import { RunBulkActionBar } from "@/components/instruments/runs-table/run-bulk-action-bar";
import { RunSelectionProvider } from "@/components/instruments/runs-table/run-selection-provider";
import { PaginationNav } from "@/components/pagination-nav";
import {
  TablePendingBoundary,
  TablePendingProvider,
} from "@/components/table-pending";
import { getInstruments, getMyRunsStats } from "@/lib/api/dashboard";
import { buildRunListQuery } from "@/lib/api/instrument-runs";
import { auth } from "@/lib/auth";
import { dashboardParamsCache, hasActiveFilters } from "@/lib/search-params";

type DashboardParams = Awaited<ReturnType<typeof dashboardParamsCache.parse>>;

const description = "Runs you're attributed to across the lab's instruments.";

export const metadata: Metadata = {
  title: "My runs",
  description,
  openGraph: { title: "My runs", description },
  twitter: { title: "My runs", description },
};

export default async function MyRunsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session) {
    return (
      <SignInRequired callbackUrl="/my-runs">
        Sign in to view your runs.
      </SignInRequired>
    );
  }

  const params = dashboardParamsCache.parse(await searchParams);
  const userId = session.user.id;

  // Each section fetches its own data behind a Suspense boundary so the static
  // shell paints immediately and the stats + runs stream in independently.
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 p-6 2xl:w-7xl">
      <section className="flex flex-col gap-3">
        <h1 className="font-medium text-lg tracking-tight">My runs</h1>
        <Suspense fallback={<MyRunsStatsCardsSkeleton />}>
          <MyRunsStatsSection userId={userId} />
        </Suspense>
      </section>

      <section className="flex flex-col gap-3">
        <Suspense fallback={<DashboardRunsSkeleton />}>
          <MyRunsSection params={params} userId={userId} />
        </Suspense>
      </section>
    </div>
  );
}

async function MyRunsStatsSection({ userId }: { userId: string }) {
  const stats = await getMyRunsStats(userId);
  return <MyRunsStatsCards stats={stats} />;
}

async function MyRunsSection({
  params,
  userId,
}: {
  params: DashboardParams;
  userId: string;
}) {
  const instrumentIds =
    params.instrument_id.length > 0 ? params.instrument_id : undefined;

  // The toolbar instrument list and the filtered run page are independent.
  // Runs are scoped to the viewer via `ranBy`, so the URL `ran_by` param (which
  // the dashboard toolbar never sets here) is intentionally ignored.
  const [instruments, runResult] = await Promise.all([
    getInstruments(true),
    buildRunListQuery({
      ranBy: userId,
      instrumentId: instrumentIds,
      search: params.search || undefined,
      dateFrom: params.date_from ?? undefined,
      dateTo: params.date_to ?? undefined,
      page: params.page,
      perPage: params.per_page,
      includeDeleted: params.include_deleted,
      statuses: params.status.length > 0 ? params.status : undefined,
    }),
  ]);

  const hasFilters = hasActiveFilters(params);
  const pendingUploadCount = runResult.data.filter(
    (row) => row.files_pending_upload > 0
  ).length;
  const unattributedCount = runResult.data.filter(
    (row) => row.attributions.length === 0
  ).length;
  // Every row is attributed to the viewer here, so "ran by you" equals the
  // shown count; the footer still reports it for consistency with other tables.
  const ranByYouCount = runResult.data.length;

  return (
    <RunSelectionProvider>
      <TablePendingProvider>
        <div className="flex flex-col gap-3">
          <RunsToolbar instruments={instruments} />
          <RunBulkActionBar />
          <TablePendingBoundary>
            <RunsTable
              data={runResult.data}
              emptyLabel="No runs attributed to you yet."
              hasFilters={hasFilters}
              pendingUploadCount={pendingUploadCount}
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
