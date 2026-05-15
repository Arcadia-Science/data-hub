import { SignInRequired } from "@/components/auth/sign-in-required";
import { RunAttributionsSection } from "@/components/runs/run-attributions-section";
import { RunCommentsSection } from "@/components/runs/run-comments-section";
import { RunDetailVariant } from "@/components/runs/variants";
import { WatcherStatusProvider } from "@/components/runs/watcher-status-provider";
import {
  getProcessedCsvData,
  getRunFiles,
  lookupRunByNaturalKey,
} from "@/lib/api/instrument-runs";
import { getInstrumentById } from "@/lib/api/instruments";
import { listCommentsForRun } from "@/lib/api/run-comments";
import { auth } from "@/lib/auth";
import { formatDate } from "@/lib/date";
import { notFound } from "next/navigation";
import type { Metadata } from "next/types";

type Props = {
  params: Promise<{ instrumentId: string; runId: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { instrumentId, runId } = await params;
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) return { title: "Run Not Found" };

  const title = `${run.runId} | ${run.instrumentDisplayName}`;

  // Surface the on-instrument acquisition time when known and label it
  // "Acquired" to match the run header. Older runs and lambda-only paths
  // don't always have `acquiredAt`, so fall back to `createdAt` and label
  // it "Reported" — same vocabulary as the visible header.
  const dateLabel = run.acquiredAt ? "Acquired" : "Reported";
  const effectiveDate = run.acquiredAt ?? run.createdAt;

  // `getRunFiles` returns every file row (including soft-deleted and
  // lambda-produced artifacts). The unfurl description only counts the
  // active raw uploads so deleted files don't inflate the headline.
  const allFiles = await getRunFiles(run.id);
  const rawFileCount = allFiles.filter(
    (f) => f.category === "raw" && f.deletedAt === null
  ).length;
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

export default async function RunDetailPage({ params }: Props) {
  const session = await auth();
  const { instrumentId, runId } = await params;

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
  if (!run) notFound();

  const [runFiles, instrument, comments] = await Promise.all([
    getRunFiles(run.id),
    getInstrumentById(instrumentId),
    listCommentsForRun(run.id),
  ]);
  const wellData = await getProcessedCsvData(runFiles);
  // Gate client-side upload actions on watcher availability — a queued
  // upload request is a no-op if no agent is around to action it.
  const isWatcherOnline = (instrument?.watchersOnline ?? 0) > 0;

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <WatcherStatusProvider isWatcherOnline={isWatcherOnline}>
        <RunDetailVariant
          run={run}
          files={runFiles}
          wellData={wellData}
          instrumentId={instrumentId}
          runId={runId}
          attributionsSlot={
            <RunAttributionsSection
              instrumentId={run.instrumentId}
              runId={run.runId}
              attributions={run.attributions}
            />
          }
        />
        <RunCommentsSection
          instrumentId={run.instrumentId}
          runId={run.runId}
          comments={comments}
        />
      </WatcherStatusProvider>
    </div>
  );
}
