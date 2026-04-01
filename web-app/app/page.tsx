import {
  InstrumentCards,
  InstrumentCardsSkeleton,
} from "@/components/dashboard/instrument-cards";
import { RunsPagination } from "@/components/dashboard/runs-pagination";
import {
  RunsTable,
  RunsTableSkeleton,
} from "@/components/dashboard/runs-table";
import { RunsToolbar } from "@/components/dashboard/runs-toolbar";
import { getInstruments } from "@/lib/api/dashboard";
import { buildRunListQuery } from "@/lib/api/instrument-runs";
import { auth } from "@/lib/auth";
import { dashboardParamsCache } from "@/lib/search-params";
import { redirect } from "next/navigation";
import type { Metadata } from "next/types";
import { Suspense } from "react";

export const metadata: Metadata = {
  title: "Dashboard | Data Hub",
};

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await auth();
  if (!session) redirect("/login");

  const params = dashboardParamsCache.parse(await searchParams);

  const instrumentIds =
    params.instrument_id.length > 0 ? params.instrument_id : undefined;

  const [instruments, runResult] = await Promise.all([
    getInstruments(),
    buildRunListQuery({
      instrumentId: instrumentIds,
      search: params.search || undefined,
      dateFrom: params.date_from ?? undefined,
      dateTo: params.date_to ?? undefined,
      page: params.page,
      perPage: params.per_page,
      includeDeleted: params.include_deleted,
    }),
  ]);

  const hasFilters =
    params.search !== "" ||
    params.instrument_id.length > 0 ||
    params.date_from !== null ||
    params.date_to !== null ||
    params.include_deleted;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <Suspense fallback={<InstrumentCardsSkeleton />}>
        <InstrumentCards />
      </Suspense>

      <RunsToolbar instruments={instruments} />

      <Suspense key={JSON.stringify(params)} fallback={<RunsTableSkeleton />}>
        <RunsTable data={runResult.data} hasFilters={hasFilters} />
      </Suspense>

      <RunsPagination pagination={runResult.pagination} />
    </div>
  );
}
