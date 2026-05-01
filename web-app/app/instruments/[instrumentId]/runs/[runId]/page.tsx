import { RunAttributionsSection } from "@/components/runs/run-attributions-section";
import { RunDetailVariant } from "@/components/runs/variants";
import { WatcherStatusProvider } from "@/components/runs/watcher-status-provider";
import {
  getProcessedCsvData,
  getRunFiles,
  lookupRunByNaturalKey,
} from "@/lib/api/instrument-runs";
import { getInstrumentById } from "@/lib/api/instruments";
import { auth } from "@/lib/auth";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next/types";

type Props = {
  params: Promise<{ instrumentId: string; runId: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { instrumentId, runId } = await params;
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) return { title: "Run Not Found" };
  return {
    title: `Run: ${run.runId} | ${run.instrumentDisplayName}`,
  };
}

export default async function RunDetailPage({ params }: Props) {
  const session = await auth();
  if (!session) redirect("/login");

  const { instrumentId, runId } = await params;

  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) notFound();

  const [runFiles, instrument] = await Promise.all([
    getRunFiles(run.id),
    getInstrumentById(instrumentId),
  ]);
  const wellData = await getProcessedCsvData(runFiles);
  // Gate client-side upload actions on watcher availability — a queued
  // upload request is a no-op if no agent is around to action it.
  const isWatcherOnline = (instrument?.watchersOnline ?? 0) > 0;

  return (
    <div className="mx-auto flex w-6xl max-w-7xl flex-col gap-6 p-6">
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
      </WatcherStatusProvider>
    </div>
  );
}
