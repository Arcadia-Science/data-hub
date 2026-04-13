import { RunDetailVariant } from "@/components/runs/variants";
import {
  getRunFiles,
  getRunReportData,
  lookupRunByNaturalKey,
} from "@/lib/api/instrument-runs";
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

  const [files, reportData] = await Promise.all([
    getRunFiles(run.id),
    getRunReportData(run.id),
  ]);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <RunDetailVariant
        run={run}
        files={files}
        reportData={reportData}
        instrumentId={instrumentId}
        runId={runId}
      />
    </div>
  );
}
