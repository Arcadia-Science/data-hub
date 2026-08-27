import { notFound } from "next/navigation";
import type { Metadata } from "next/types";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import {
  InstrumentHeader,
  InstrumentHeaderSkeleton,
} from "@/components/instruments/instrument-header";
import { InstrumentRunsToolbar } from "@/components/instruments/instrument-runs-toolbar";
import {
  InstrumentRunsTableShell,
  type RanByOption,
  type RunRow,
} from "@/components/instruments/runs-table";
import { AuntyRunsTable } from "@/components/instruments/runs-table/aunty-runs-table";
import { DefaultRunsTable } from "@/components/instruments/runs-table/default-runs-table";
import { EpsonScannerRunsTable } from "@/components/instruments/runs-table/epson-scanner-runs-table";
import { GelDocRunsTable } from "@/components/instruments/runs-table/gel-doc-runs-table";
import { HinaRunsTable } from "@/components/instruments/runs-table/hina-runs-table";
import { InstrumentRunsSkeleton } from "@/components/instruments/runs-table/instrument-runs-skeleton";
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
import {
  getPreferences,
  listInstrumentSubscriptions,
} from "@/lib/api/notifications";
import { auth } from "@/lib/auth";
import { instrumentDetailParamsCache } from "@/lib/search-params";

type InstrumentDetailFilters = Awaited<
  ReturnType<typeof instrumentDetailParamsCache.parse>
>;

interface Props {
  params: Promise<{ instrumentId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

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
          filterOptions={filterOptions.options}
          instrumentId={instrumentId}
          ranByOptions={ranByOptions}
        />
      );
    case "gel_doc":
      return (
        <GelDocRunsTable
          data={data}
          filterOptions={filterOptions.options}
          instrumentId={instrumentId}
          ranByOptions={ranByOptions}
        />
      );
    case "qpcr":
      return (
        <QpcrRunsTable
          data={data}
          filterOptions={filterOptions.options}
          instrumentId={instrumentId}
          ranByOptions={ranByOptions}
        />
      );
    case "hina_microscope":
      return (
        <HinaRunsTable
          data={data}
          filterOptions={filterOptions.options}
          instrumentId={instrumentId}
          ranByOptions={ranByOptions}
        />
      );
    case "epson_v700_scanner":
      return (
        <EpsonScannerRunsTable
          data={data}
          filterOptions={filterOptions.options}
          instrumentId={instrumentId}
          ranByOptions={ranByOptions}
        />
      );
    case "aunty":
      return (
        <AuntyRunsTable
          data={data}
          filterOptions={filterOptions.options}
          instrumentId={instrumentId}
          ranByOptions={ranByOptions}
        />
      );
    default:
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
  const userId = session.user.id;

  // The header and the runs table stream independently: each is its own
  // Suspense child so their queries run in parallel (the shared
  // `getInstrumentById` is `cache()`-deduped) and the header paints without
  // waiting on the heavier runs / filter-option queries.
  const isAdmin = session.user.isAdmin === true;

  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <Suspense fallback={<InstrumentHeaderSkeleton />}>
        <InstrumentHeaderSection
          instrumentId={instrumentId}
          isAdmin={isAdmin}
          userId={userId}
        />
      </Suspense>
      <Suspense fallback={<InstrumentRunsSkeleton />}>
        <InstrumentRunsSection
          filters={filters}
          instrumentId={instrumentId}
          userId={userId}
        />
      </Suspense>
    </div>
  );
}

async function InstrumentHeaderSection({
  instrumentId,
  isAdmin,
  userId,
}: {
  instrumentId: string;
  isAdmin: boolean;
  userId: string;
}) {
  // Header data: instrument metadata plus the viewer's notification prefs +
  // per-instrument subscription state. All independent, so fetch together.
  const [instrument, notificationPrefs, notificationSubscriptions] =
    await Promise.all([
      getInstrumentById(instrumentId),
      getPreferences(userId),
      listInstrumentSubscriptions(userId),
    ]);

  if (!instrument) {
    notFound();
  }

  // The subscription list always contains every instrument (left-joined
  // against `instruments`) so a missing entry would mean a stale read —
  // fall back to `false` defensively.
  const subscriptionForThisInstrument = notificationSubscriptions.find(
    (s) => s.instrumentId === instrumentId
  );

  return (
    <InstrumentHeader
      instrument={instrument}
      isAdmin={isAdmin}
      notifications={{
        enabled: subscriptionForThisInstrument?.enabled ?? false,
        masterMuted: notificationPrefs.runsAllMuted,
      }}
    />
  );
}

async function InstrumentRunsSection({
  instrumentId,
  filters,
  userId,
}: {
  instrumentId: string;
  filters: InstrumentDetailFilters;
  userId: string;
}) {
  // `getInstrumentById` is `cache()`-deduped, so this resolves against the
  // same fetch the header section kicked off — no second query. We need it
  // here for the run-table variant + filter-option discriminator.
  const instrument = await getInstrumentById(instrumentId);
  if (!instrument) {
    notFound();
  }

  // Paginated runs plus the per-instrument filter options and attribution
  // dropdown options are independent once we know the instrument type.
  const [runResult, filterOptions, ranByUsers] = await Promise.all([
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
      auntyExperimentType: filters.aunty_experiment_type ?? undefined,
      auntyAnalysisMode: filters.aunty_analysis_mode ?? undefined,
      auntyTemperature: filters.aunty_temperature ?? undefined,
      auntyRampRate: filters.aunty_ramp_rate ?? undefined,
      ranBy: filters.ran_by ?? undefined,
      statuses: filters.status.length > 0 ? filters.status : undefined,
    }),
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
    filters.aunty_experiment_type !== null ||
    filters.aunty_analysis_mode !== null ||
    filters.aunty_temperature !== null ||
    filters.aunty_ramp_rate !== null ||
    filters.ran_by !== null ||
    filters.status.length > 0;

  const pendingUploadCount = runResult.data.filter(
    (row) => row.files_pending_upload > 0
  ).length;
  const unattributedCount = runResult.data.filter(
    (row) => row.attributions.length === 0
  ).length;
  const ranByYouCount = runResult.data.filter((row) =>
    row.attributions.some((a) => a.userId === userId)
  ).length;

  // Build the "Ran By" dropdown options: the current user (labelled "You"),
  // pinned to the top if they've attributed anything here, followed by other
  // attributors by display name, then the "Unattributed" sentinel.
  const meOption = ranByUsers.find((u) => u.userId === userId);
  const ranByOptions = [
    ...(meOption ? [{ value: meOption.userId, label: "You" }] : []),
    ...ranByUsers
      .filter((u) => u.userId !== userId)
      .map((u) => ({ value: u.userId, label: u.displayName })),
    { value: "unattributed", label: "Unattributed" },
  ];

  return (
    <RunSelectionProvider>
      <TablePendingProvider>
        <div className="flex flex-col gap-3">
          <InstrumentRunsToolbar />
          <RunBulkActionBar />
          <TablePendingBoundary>
            <InstrumentRunsTableShell
              hasFilters={hasFilters}
              isEmpty={runResult.data.length === 0}
              pendingUploadCount={pendingUploadCount}
              ranByYouCount={ranByYouCount}
              shownCount={runResult.data.length}
              totalCount={runResult.pagination.total}
              unattributedCount={unattributedCount}
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
            pageParam="page"
            totalPages={runResult.pagination.total_pages}
          />
        </div>
      </TablePendingProvider>
    </RunSelectionProvider>
  );
}
