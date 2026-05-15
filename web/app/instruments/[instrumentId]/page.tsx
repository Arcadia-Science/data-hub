import { SignInRequired } from "@/components/auth/sign-in-required";
import { InstrumentHeader } from "@/components/instruments/instrument-header";
import { InstrumentRunsToolbar } from "@/components/instruments/instrument-runs-toolbar";
import {
  InstrumentRunsTableShell,
  type RanByOption,
  type RunRow,
} from "@/components/instruments/runs-table";
import { DefaultRunsTable } from "@/components/instruments/runs-table/default-runs-table";
import { EpsonScannerRunsTable } from "@/components/instruments/runs-table/epson-scanner-runs-table";
import { GelDocRunsTable } from "@/components/instruments/runs-table/gel-doc-runs-table";
import { HinaRunsTable } from "@/components/instruments/runs-table/hina-runs-table";
import { PlateReaderRunsTable } from "@/components/instruments/runs-table/plate-reader-runs-table";
import { QpcrRunsTable } from "@/components/instruments/runs-table/qpcr-runs-table";
import { RunBulkActionBar } from "@/components/instruments/runs-table/run-bulk-action-bar";
import { RunSelectionProvider } from "@/components/instruments/runs-table/run-selection-provider";
import { PaginationNav } from "@/components/pagination-nav";
import {
  TablePendingBoundary,
  TablePendingProvider,
} from "@/components/table-pending";
import {
  buildRunListQuery,
  getInstrumentFilterOptions,
  getRanByFilterOptions,
  type InstrumentFilterOptionsByType,
} from "@/lib/api/instrument-runs";
import { getInstrumentById } from "@/lib/api/instruments";
import { auth } from "@/lib/auth";
import { instrumentDetailParamsCache } from "@/lib/search-params";
import { notFound } from "next/navigation";
import type { Metadata } from "next/types";

type Props = {
  params: Promise<{ instrumentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { instrumentId } = await params;
  const instrument = await getInstrumentById(instrumentId);
  const title = instrument?.displayName ?? instrumentId;
  // Description is intentionally minimal — it surfaces in Slack/Notion link
  // previews. Anything in the URL slug is already visible to the sharer;
  // we don't include sensitive bits (run counts, watcher status, etc.).
  const description = instrument
    ? `${instrument.displayName} runs on Data Hub.`
    : "Data Hub instrument.";
  return {
    title,
    description,
    openGraph: { title, description, type: "article" },
    twitter: { card: "summary", title, description },
  };
}

/**
 * Render the per-instrument runs table variant for the given filter-options
 * discriminator. Narrowing on `filterOptions.kind` removes the per-variant
 * optional-prop + `!` pattern that used to live in `InstrumentRunsTable`.
 */
function renderRunsTableVariant(
  filterOptions: InstrumentFilterOptionsByType,
  data: RunRow[],
  instrumentId: string,
  ranByOptions: RanByOption[]
) {
  switch (filterOptions.kind) {
    case "plate_reader":
      return (
        <PlateReaderRunsTable
          data={data}
          instrumentId={instrumentId}
          filterOptions={filterOptions.options}
          ranByOptions={ranByOptions}
        />
      );
    case "gel_doc":
      return (
        <GelDocRunsTable
          data={data}
          instrumentId={instrumentId}
          filterOptions={filterOptions.options}
          ranByOptions={ranByOptions}
        />
      );
    case "qpcr":
      return (
        <QpcrRunsTable
          data={data}
          instrumentId={instrumentId}
          filterOptions={filterOptions.options}
          ranByOptions={ranByOptions}
        />
      );
    case "hina_microscope":
      return (
        <HinaRunsTable
          data={data}
          instrumentId={instrumentId}
          filterOptions={filterOptions.options}
          ranByOptions={ranByOptions}
        />
      );
    case "epson_v700_scanner":
      return (
        <EpsonScannerRunsTable
          data={data}
          instrumentId={instrumentId}
          filterOptions={filterOptions.options}
          ranByOptions={ranByOptions}
        />
      );
    case "default":
      return (
        <DefaultRunsTable
          data={data}
          instrumentId={instrumentId}
          ranByOptions={ranByOptions}
        />
      );
  }
}

export default async function InstrumentDetailPage({
  params,
  searchParams,
}: Props) {
  const session = await auth();
  const { instrumentId } = await params;
  // generateMetadata above still runs without a session, so unfurlers see
  // the instrument name in the link preview. Real visitors without a
  // session get a sign-in CTA that returns them here afterwards.
  if (!session) {
    return (
      <SignInRequired callbackUrl={`/instruments/${instrumentId}`}>
        Sign in to view this instrument&rsquo;s runs.
      </SignInRequired>
    );
  }

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
      hinaChannel: filters.hina_channel ?? undefined,
      hinaDimension: filters.hina_dimension ?? undefined,
      hinaSize: filters.hina_size ?? undefined,
      dpi: filters.dpi ?? undefined,
      colorMode: filters.color_mode ?? undefined,
      ranBy: filters.ran_by ?? undefined,
    }),
  ]);

  if (!instrument) notFound();

  // Fetch whichever per-instrument filter options apply, in parallel with
  // the attribution dropdown options.
  const [filterOptions, ranByUsers] = await Promise.all([
    getInstrumentFilterOptions(instrument.instrumentType, instrumentId),
    getRanByFilterOptions(instrumentId),
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
    filters.dye_channel !== null ||
    filters.hina_channel !== null ||
    filters.hina_dimension !== null ||
    filters.hina_size !== null ||
    filters.dpi !== null ||
    filters.color_mode !== null ||
    filters.ran_by !== null;

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

  // Build the "Ran By" dropdown options: the current user (labelled "You"),
  // pinned to the top if they've attributed anything here, followed by other
  // attributors by display name, then the "Unattributed" sentinel.
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

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <InstrumentHeader instrument={instrument} />
      <RunSelectionProvider>
        <TablePendingProvider>
          <InstrumentRunsToolbar />
          <RunBulkActionBar />
          <TablePendingBoundary>
            <InstrumentRunsTableShell
              isEmpty={runResult.data.length === 0}
              hasFilters={hasFilters}
              shownCount={runResult.data.length}
              totalCount={runResult.pagination.total}
              pendingUploadCount={pendingUploadCount}
              unattributedCount={unattributedCount}
              ranByYouCount={ranByYouCount}
            >
              {renderRunsTableVariant(
                filterOptions,
                runResult.data,
                instrumentId,
                ranByOptions
              )}
            </InstrumentRunsTableShell>
          </TablePendingBoundary>
          <PaginationNav
            page={runResult.pagination.page}
            totalPages={runResult.pagination.total_pages}
            pageParam="page"
          />
        </TablePendingProvider>
      </RunSelectionProvider>
    </div>
  );
}
