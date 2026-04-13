import {
  InstrumentCards,
  InstrumentCardsSkeleton,
} from "@/components/dashboard/instrument-cards";
import { RunsTable } from "@/components/dashboard/runs-table";
import { RunsToolbar } from "@/components/dashboard/runs-toolbar";
import { PaginationNav } from "@/components/pagination-nav";
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

  // Fetch the instrument list (for the toolbar combobox) and the filtered run
  // page in parallel since neither depends on the other's result.
  const [instruments, runResult] = await Promise.all([
    getInstruments(),
    buildRunListQuery({
      instrumentId: instrumentIds,
      search: params.search || undefined,
      dateFrom: params.date_from ?? new Date().toISOString().slice(0, 10),
      dateTo: params.date_to ?? undefined,
      page: params.page,
      perPage: params.per_page,
      includeDeleted: params.include_deleted,
    }),
  ]);

  const hasFilters = hasActiveFilters(params);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <Suspense fallback={<InstrumentCardsSkeleton />}>
        <InstrumentCards />
      </Suspense>

      <RunsToolbar instruments={instruments} />

      <RunsTable data={runResult.data} hasFilters={hasFilters} />
      <PaginationNav
        page={runResult.pagination.page}
        totalPages={runResult.pagination.total_pages}
        pageParam="page"
      />
    </div>
  );
}
