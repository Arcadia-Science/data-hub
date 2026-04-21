import { InstrumentHeader } from "@/components/instruments/instrument-header";
import { InstrumentRunsToolbar } from "@/components/instruments/instrument-runs-toolbar";
import { InstrumentRunsTable } from "@/components/instruments/runs-table";
import { PaginationNav } from "@/components/pagination-nav";
import {
  buildRunListQuery,
  getGelDocFilterOptions,
  getPlateReaderFilterOptions,
  getQpcrFilterOptions,
} from "@/lib/api/instrument-runs";
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
      wavelength: filters.wavelength ?? undefined,
      measurementMode: filters.measurement_mode ?? undefined,
      measurementType: filters.measurement_type ?? undefined,
      captureType: filters.capture_type ?? undefined,
      imagingMode: filters.imaging_mode ?? undefined,
      gelWavelength: filters.gel_wavelength ?? undefined,
      gelColor: filters.gel_color ?? undefined,
      dyeChannel: filters.dye_channel ?? undefined,
    }),
  ]);

  if (!instrument) notFound();

  const isPlateReader = instrument.instrumentType === "plate_reader";
  const isGelDoc = instrument.instrumentType === "gel_doc";
  const isQpcr = instrument.instrumentType === "qpcr";

  // Fetch distinct metadata values for instrument-specific column filter dropdowns.
  const [filterOptions, gelDocFilterOptions, qpcrFilterOptions] =
    await Promise.all([
      isPlateReader ? getPlateReaderFilterOptions(instrumentId) : undefined,
      isGelDoc ? getGelDocFilterOptions(instrumentId) : undefined,
      isQpcr ? getQpcrFilterOptions(instrumentId) : undefined,
    ]);

  const hasFilters =
    filters.search !== "" ||
    filters.date_from !== null ||
    filters.date_to !== null ||
    filters.include_deleted ||
    filters.wavelength !== null ||
    filters.measurement_mode !== null ||
    filters.measurement_type !== null ||
    filters.capture_type !== null ||
    filters.imaging_mode !== null ||
    filters.gel_wavelength !== null ||
    filters.gel_color !== null ||
    filters.dye_channel !== null;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <InstrumentHeader instrument={instrument} />
      <InstrumentRunsToolbar />
      <InstrumentRunsTable
        data={runResult.data}
        instrumentId={instrumentId}
        instrumentType={instrument.instrumentType}
        hasFilters={hasFilters}
        filterOptions={filterOptions}
        gelDocFilterOptions={gelDocFilterOptions}
        qpcrFilterOptions={qpcrFilterOptions}
      />
      <PaginationNav
        page={runResult.pagination.page}
        totalPages={runResult.pagination.total_pages}
        pageParam="page"
      />
    </div>
  );
}
