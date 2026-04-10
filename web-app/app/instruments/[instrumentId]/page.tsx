import { InstrumentHeader } from "@/components/instruments/instrument-header";
import { InstrumentRunsTable } from "@/components/instruments/instrument-runs-table";
import { InstrumentRunsToolbar } from "@/components/instruments/instrument-runs-toolbar";
import { PaginationNav } from "@/components/pagination-nav";
import { buildRunListQuery } from "@/lib/api/instrument-runs";
import { getInstrumentById } from "@/lib/api/instruments";
import { auth } from "@/lib/auth";
import { instrumentDetailParamsCache } from "@/lib/search-params";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next/types";

type Props = {
  params: Promise<{ instrumentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { instrumentId } = await params;
  const instrument = await getInstrumentById(instrumentId);
  return {
    title: instrument?.displayName ?? instrumentId,
  };
}

export default async function InstrumentDetailPage({
  params,
  searchParams,
}: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { instrumentId } = await params;
  const filters = instrumentDetailParamsCache.parse(await searchParams);

  // Parallel fetch: instrument metadata (for header) and paginated runs
  // (for table) are independent queries — neither depends on the other.
  const [instrument, runResult] = await Promise.all([
    getInstrumentById(instrumentId),
    buildRunListQuery({
      instrumentId,
      search: filters.search || undefined,
      dateFrom: filters.date_from ?? undefined,
      dateTo: filters.date_to ?? undefined,
      page: filters.page,
      perPage: filters.per_page,
      includeDeleted: filters.include_deleted,
    }),
  ]);

  if (!instrument) notFound();

  // Computed separately from the toolbar's client-side check because this
  // server component needs it for the empty-state message distinction.
  const hasFilters =
    filters.search !== "" ||
    filters.date_from !== null ||
    filters.date_to !== null ||
    filters.include_deleted;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <InstrumentHeader instrument={instrument} />
      <InstrumentRunsToolbar />
      <InstrumentRunsTable
        data={runResult.data}
        instrumentId={instrumentId}
        hasFilters={hasFilters}
      />
      <PaginationNav
        page={runResult.pagination.page}
        totalPages={runResult.pagination.total_pages}
        pageParam="page"
      />
    </div>
  );
}
