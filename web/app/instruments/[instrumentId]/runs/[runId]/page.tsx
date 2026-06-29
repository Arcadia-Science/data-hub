import { notFound } from "next/navigation";
import type { Metadata } from "next/types";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { RunAttributionsSection } from "@/components/runs/run-attributions-section";
import { RunCommentsSection } from "@/components/runs/run-comments-section";
import { RunDetailVariant } from "@/components/runs/variants";
import { WatcherStatusProvider } from "@/components/runs/watcher-status-provider";
import {
  buildRunFilesQuery,
  getProcessedCsvData,
  getRunFileStats,
  getRunImageFiles,
  getRunReportFiles,
  lookupRunByNaturalKey,
} from "@/lib/api/instrument-runs";
import { getInstrumentById } from "@/lib/api/instruments";
import { listCommentsForRun } from "@/lib/api/run-comments";
import { auth } from "@/lib/auth";
import { formatDate } from "@/lib/date";
import { runDetailParamsCache } from "@/lib/search-params";

const FILES_PER_PAGE = 10;

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

  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    notFound();
  }

  // Only imaging instruments use the carousel, so only they pay for the query.
  const isImagingInstrument =
    run.instrumentType === "gel_doc" ||
    run.instrumentType === "hina_microscope";

  const [
    filesPage,
    fileStats,
    reportFiles,
    reportImages,
    instrument,
    comments,
  ] = await Promise.all([
    buildRunFilesQuery(run.id, {
      page: filters.files_page,
      perPage: FILES_PER_PAGE,
      search: filters.files_search || undefined,
      status: filters.files_status,
      sort: filters.files_sort,
      includeDismissed: filters.files_dismissed,
    }),
    getRunFileStats(run.id),
    getRunReportFiles(run.id),
    isImagingInstrument ? getRunImageFiles(run.id) : Promise.resolve([]),
    getInstrumentById(instrumentId),
    listCommentsForRun(run.id),
  ]);
  const wellData = await getProcessedCsvData(reportFiles);
  // Gate client-side upload actions on watcher availability — a queued
  // upload request is a no-op if no agent is around to action it.
  const isWatcherOnline = (instrument?.watchersOnline ?? 0) > 0;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <WatcherStatusProvider isWatcherOnline={isWatcherOnline}>
        <RunDetailVariant
          attributionsSlot={
            <RunAttributionsSection
              attributions={run.attributions}
              instrumentId={run.instrumentId}
              runId={run.runId}
            />
          }
          fileStats={fileStats}
          files={filesPage.data}
          filesDownloadableCount={filesPage.downloadableCount}
          filesPagination={filesPage.pagination}
          instrumentId={instrumentId}
          reportFiles={reportFiles}
          reportImages={reportImages}
          run={run}
          runId={runId}
          wellData={wellData}
        />
        <RunCommentsSection
          comments={comments}
          instrumentId={run.instrumentId}
          runId={run.runId}
        />
      </WatcherStatusProvider>
    </div>
  );
}
