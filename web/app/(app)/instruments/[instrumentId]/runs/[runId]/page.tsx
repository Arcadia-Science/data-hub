import { notFound } from "next/navigation";
import type { Metadata } from "next/types";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { RestReportDataSourceProvider } from "@/components/runs/report-data-source-provider";
import { RunAttributionsSection } from "@/components/runs/run-attributions-section";
import { RunCommentsSection } from "@/components/runs/run-comments-section";
import {
  RunCommentsSkeleton,
  RunContentSkeleton,
} from "@/components/runs/run-detail-skeleton";
import { RunNav } from "@/components/runs/run-nav";
import { RunDetailVariant } from "@/components/runs/variants";
import { WatcherStatusProvider } from "@/components/runs/watcher-status-provider";
import {
  buildRunFilesQuery,
  getAdjacentRunIds,
  getAuntyPlateData,
  getProcessedCsvData,
  getQpcrMeltingPlateData,
  getRunFileStats,
  getRunReportFiles,
  lookupRunByNaturalKey,
  type RunDetail,
} from "@/lib/api/instrument-runs";
import { getInstrumentById } from "@/lib/api/instruments";
import { getReportItemsPage } from "@/lib/api/report-items";
import { listCommentsForRun } from "@/lib/api/run-comments";
import { auth } from "@/lib/auth";
import { formatDate } from "@/lib/date";
import {
  emptyReportItemsPage,
  REPORT_ITEMS_WINDOW,
  reportItemKindForInstrument,
} from "@/lib/runs/report-items";
import { runDetailParamsCache } from "@/lib/search-params";

const FILES_PER_PAGE = 10;

type RunDetailFilters = Awaited<ReturnType<typeof runDetailParamsCache.parse>>;

interface Props {
  params: Promise<{ instrumentId: string; runId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { instrumentId, runId } = await params;
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    return { title: "Run Not Found" };
  }

  const title = `${run.runId} | ${run.instrumentDisplayName}`;

  // Surface the on-instrument acquisition time when known and label it
  // "Acquired" to match the run header. Older runs and lambda-only paths
  // don't always have `acquiredAt`, so fall back to `createdAt` and label
  // it "Reported" — same vocabulary as the visible header.
  const dateLabel = run.acquiredAt ? "Acquired" : "Reported";
  const effectiveDate = run.acquiredAt ?? run.createdAt;

  // The unfurl description only counts active raw uploads so deleted files
  // don't inflate the headline. A single aggregate query avoids loading the
  // full file list just to count.
  const { rawActive: rawFileCount } = await getRunFileStats(run.id);
  const fileLabel =
    rawFileCount === 1 ? "1 raw data file" : `${rawFileCount} raw data files`;

  const description = `${dateLabel} ${formatDate(effectiveDate)} \u00b7 ${fileLabel}`;
  return {
    title,
    description,
    openGraph: { title, description, type: "article" },
    twitter: { card: "summary", title, description },
  };
}

export default async function RunDetailPage({ params, searchParams }: Props) {
  const session = await auth();
  const { instrumentId, runId } = await params;
  const filters = runDetailParamsCache.parse(await searchParams);

  // The route is publicly reachable so Slack/Notion unfurlers can read the
  // run + instrument title from `generateMetadata`. Humans without a
  // session see a sign-in CTA that returns them here afterwards.
  if (!session) {
    return (
      <SignInRequired
        callbackUrl={`/instruments/${instrumentId}/runs/${runId}`}
      >
        Sign in to view this run.
      </SignInRequired>
    );
  }

  // Run lookup and heavy fetches live inside Suspense so the shell + skeletons
  // paint immediately on navigation. `lookupRunByNaturalKey` is `cache()`-deduped
  // across the content and comments loaders on the same request.
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <Suspense fallback={<RunContentSkeleton instrumentType="generic" />}>
        <RunDetailContent
          filters={filters}
          instrumentId={instrumentId}
          runId={runId}
        />
      </Suspense>
      <Suspense fallback={<RunCommentsSkeleton />}>
        <RunCommentsLoader instrumentId={instrumentId} runId={runId} />
      </Suspense>
    </div>
  );
}

async function RunDetailContent({
  instrumentId,
  runId,
  filters,
}: {
  instrumentId: string;
  runId: string;
  filters: RunDetailFilters;
}) {
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    notFound();
  }

  // Instrument type is unknown to the outer fallback, so stream file/report
  // fetches behind a typed skeleton once the natural-key lookup resolves.
  return (
    <Suspense
      fallback={<RunContentSkeleton instrumentType={run.instrumentType} />}
    >
      <RunDetailContentBody
        filters={filters}
        instrumentId={instrumentId}
        run={run}
        runId={runId}
      />
    </Suspense>
  );
}

async function RunDetailContentBody({
  run,
  instrumentId,
  runId,
  filters,
}: {
  run: RunDetail;
  instrumentId: string;
  runId: string;
  filters: RunDetailFilters;
}) {
  // Only variants with a seekable report viewer pay for the item query.
  const reportItemKind = reportItemKindForInstrument(run.instrumentType);

  // `wellData` derives from the report files, so it can't run in the same
  // fan-out as its own input. Chaining it off `reportFilesPromise` keeps it in
  // the single `Promise.all` batch instead of a sequential await afterward, so
  // CSV processing overlaps the other queries rather than tacking latency on.
  const reportFilesPromise = getRunReportFiles(run.id);
  const isAunty = run.instrumentType === "aunty";
  const isQpcr = run.instrumentType === "qpcr";
  const [
    filesPage,
    fileStats,
    reportFiles,
    reportItems,
    instrument,
    adjacentRuns,
    wellData,
    auntyPlate,
    qpcrMeltingPlate,
  ] = await Promise.all([
    buildRunFilesQuery(run.id, {
      page: filters.files_page,
      perPage: FILES_PER_PAGE,
      search: filters.files_search || undefined,
      categories: filters.files_category,
      statuses: filters.files_status,
      sort: filters.files_sort,
      includeDismissed: filters.files_dismissed,
    }),
    getRunFileStats(run.id),
    reportFilesPromise,
    reportItemKind
      ? getReportItemsPage(run.id, {
          kind: reportItemKind,
          offset: 0,
          limit: REPORT_ITEMS_WINDOW,
        })
      : Promise.resolve(emptyReportItemsPage()),
    getInstrumentById(instrumentId),
    getAdjacentRunIds(run),
    reportFilesPromise.then((rf) =>
      isAunty ? Promise.resolve([]) : getProcessedCsvData(rf)
    ),
    reportFilesPromise.then((rf) =>
      isAunty ? getAuntyPlateData(rf) : Promise.resolve(null)
    ),
    reportFilesPromise.then((rf) =>
      isQpcr ? getQpcrMeltingPlateData(rf) : Promise.resolve(null)
    ),
  ]);

  // Gate client-side upload actions on watcher availability — a queued
  // upload request is a no-op if no agent is around to action it.
  const isWatcherOnline = (instrument?.watchersOnline ?? 0) > 0;

  const toRunHref = (rid: string) =>
    `/instruments/${instrumentId}/runs/${encodeURIComponent(rid)}`;

  return (
    <RestReportDataSourceProvider instrumentId={instrumentId} runId={runId}>
      <WatcherStatusProvider isWatcherOnline={isWatcherOnline}>
        <RunDetailVariant
          attributionsSlot={
            <RunAttributionsSection
              attributions={run.attributions}
              instrumentId={run.instrumentId}
              runId={run.runId}
            />
          }
          auntyPlate={auntyPlate}
          fileStats={fileStats}
          files={filesPage.data}
          filesDownloadableCount={filesPage.downloadableCount}
          filesPagination={filesPage.pagination}
          instrumentId={instrumentId}
          qpcrMeltingPlate={qpcrMeltingPlate}
          reportFiles={reportFiles}
          reportItems={reportItems}
          run={run}
          runId={runId}
          runNavSlot={
            <RunNav
              next={
                adjacentRuns.nextRunId
                  ? {
                      href: toRunHref(adjacentRuns.nextRunId),
                      runId: adjacentRuns.nextRunId,
                    }
                  : null
              }
              previous={
                adjacentRuns.previousRunId
                  ? {
                      href: toRunHref(adjacentRuns.previousRunId),
                      runId: adjacentRuns.previousRunId,
                    }
                  : null
              }
            />
          }
          wellData={wellData}
        />
      </WatcherStatusProvider>
    </RestReportDataSourceProvider>
  );
}

async function RunCommentsLoader({
  instrumentId,
  runId,
}: {
  instrumentId: string;
  runId: string;
}) {
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    notFound();
  }

  const comments = await listCommentsForRun(run.id);
  return (
    <RunCommentsSection
      comments={comments}
      instrumentId={run.instrumentId}
      runId={run.runId}
    />
  );
}
