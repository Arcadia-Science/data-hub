import { headers } from "next/headers";
import { notFound } from "next/navigation";
import type { Metadata } from "next/types";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { RunClaimTargetProvider } from "@/components/runs/claim-prompt/run-claim-target";
import { RestReportDataSourceProvider } from "@/components/runs/report-data-source-provider";
import { RunAttributionsSection } from "@/components/runs/run-attributions-section";
import { RunCommentsSection } from "@/components/runs/run-comments-section";
import {
  RunCommentsSkeleton,
  RunContentSkeleton,
} from "@/components/runs/run-detail-skeleton";
import { RunNav } from "@/components/runs/run-nav";
import { RunNotebookLinksSection } from "@/components/runs/run-notebook-links-section";
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
import { runNotebookToWire } from "@/lib/api/notebook-wire";
import { listNotebooksForRun } from "@/lib/api/notebooks";
import { getReportItemsPage } from "@/lib/api/report-items";
import { listCommentsForRun } from "@/lib/api/run-comments";
import { readRunIdParam } from "@/lib/api/run-id-param";
import { auth } from "@/lib/auth";
import { formatDateLong } from "@/lib/date";
import {
  type Connection,
  instrumentBadgeState,
} from "@/lib/instruments/connection";
import { decodePageParam } from "@/lib/runs/page-param";
import {
  emptyReportItemsPage,
  REPORT_ITEMS_WINDOW,
  reportItemKindForInstrument,
} from "@/lib/runs/report-items";
import { filesShowDeleted, runDetailParamsCache } from "@/lib/search-params";
import { getViewerTimeZone } from "@/lib/viewer-timezone";

const FILES_PER_PAGE = 10;

type RunDetailFilters = Awaited<ReturnType<typeof runDetailParamsCache.parse>>;

interface Props {
  params: Promise<{ instrumentId: string; runId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

// The run ID as the client sent it. On Vercel, Next.js decodes a page's route
// parameter twice, so the parameter is only the fallback for when the proxy
// header is missing or disagrees with it. See `readRunIdParam`.
async function readRunId(runIdParam: string) {
  return readRunIdParam(await headers(), decodePageParam(runIdParam));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { instrumentId, runId: runIdParam } = await params;
  const runId = await readRunId(runIdParam);
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    return { title: "Run not found" };
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
    rawFileCount === 0
      ? "No raw data files yet."
      : rawFileCount === 1
        ? "1 raw data file."
        : `${rawFileCount} raw data files.`;

  const timeZone = await getViewerTimeZone();
  const description = `${dateLabel} ${formatDateLong(effectiveDate, timeZone)}. ${fileLabel}`;
  return {
    title,
    description,
    openGraph: { title, description, type: "article" },
    twitter: { card: "summary", title, description },
  };
}

export default async function RunDetailPage({ params, searchParams }: Props) {
  const session = await auth();
  const { instrumentId, runId: runIdParam } = await params;
  const runId = await readRunId(runIdParam);
  const filters = runDetailParamsCache.parse(await searchParams);

  // The route is publicly reachable so Slack/Notion unfurlers can read the
  // run + instrument title from `generateMetadata`. Humans without a
  // session see a sign-in CTA that returns them here afterwards.
  if (!session) {
    return <SignInRequired>Sign in to view this run.</SignInRequired>;
  }

  // Run lookup and heavy fetches live inside Suspense so the shell + skeletons
  // paint immediately on navigation. `lookupRunByNaturalKey` is `cache()`-deduped
  // across the content and comments loaders on the same request.
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 pt-3.5 pb-6 2xl:w-6xl">
      {/* `pt-3.5` centers the breadcrumbs on the sidebar's "Navigation" label. */}
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
  const isPlateReader = run.instrumentType === "plate_reader";
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
    notebooks,
  ] = await Promise.all([
    buildRunFilesQuery(run.id, {
      page: filters.files_page,
      perPage: FILES_PER_PAGE,
      search: filters.files_search || undefined,
      categories: filters.files_category,
      statuses: filters.files_status,
      sort: filters.files_sort,
      order: filters.files_order,
      includeDeleted: filesShowDeleted(filters),
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
    // Only the plate reader view reads `wellData`, so parsing every CSV here
    // would add S3 reads and CPU time to every other run page for nothing.
    reportFilesPromise.then((rf) =>
      isPlateReader ? getProcessedCsvData(rf) : Promise.resolve([])
    ),
    reportFilesPromise.then((rf) =>
      isAunty ? getAuntyPlateData(rf) : Promise.resolve(null)
    ),
    reportFilesPromise.then((rf) =>
      isQpcr ? getQpcrMeltingPlateData(rf) : Promise.resolve(null)
    ),
    listNotebooksForRun(run.id),
  ]);

  // The upload buttons and the offline notice follow the instrument badge, so
  // a restarting watcher still takes upload requests and a retired instrument
  // doesn't. A missing instrument can't happen for a run that was found. If
  // it does, it reads as retired, the strictest reading, as in the upload
  // routes (`getInstrumentBadge` in `lib/api/run-uploads.ts`).
  const connection: Connection = instrument?.connection ?? {
    state: "offline",
    reason: "no_watcher",
  };
  const badgeState = instrumentBadgeState(
    instrument?.status ?? "inactive",
    connection
  );

  const toRunHref = (rid: string) =>
    `/instruments/${instrumentId}/runs/${encodeURIComponent(rid)}`;

  return (
    <RestReportDataSourceProvider instrumentId={instrumentId} runId={runId}>
      <WatcherStatusProvider
        badgeState={badgeState}
        instrumentId={run.instrumentId}
        instrumentName={run.instrumentDisplayName}
        lastHeartbeatAt={instrument?.watcher?.lastHeartbeatAt ?? null}
      >
        <RunClaimTargetProvider
          instrumentId={run.instrumentId}
          runId={run.runId}
          unclaimed={run.attributions.length === 0 && run.deletedAt === null}
        >
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
            filesDeletedCount={filesPage.deletedCount}
            filesDownloadableCount={filesPage.downloadableCount}
            filesPagination={filesPage.pagination}
            instrumentId={instrumentId}
            notebooksSlot={
              <RunNotebookLinksSection
                attributions={run.attributions}
                instrumentId={run.instrumentId}
                isDeleted={run.deletedAt !== null}
                key={`${run.instrumentId}:${run.runId}`}
                notebooks={notebooks.map(runNotebookToWire)}
                runId={run.runId}
              />
            }
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
        </RunClaimTargetProvider>
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
