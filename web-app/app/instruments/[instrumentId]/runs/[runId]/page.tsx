import { DeleteRunDialog } from "@/components/runs/delete-run-dialog";
import { RestoreRunButton } from "@/components/runs/restore-run-button";
import { RunAnalysisSection } from "@/components/runs/run-analysis-section";
import { RunFilesSection } from "@/components/runs/run-files-section";
import { RunHeader } from "@/components/runs/run-header";
import { RunMetadata } from "@/components/runs/run-metadata";
import { RunReportSection } from "@/components/runs/run-report-section";
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

  const isDeleted = run.deletedAt !== null;
  // Restoring is only possible before the nightly purge job removes S3 objects.
  const canRestore = isDeleted && run.filesPurgedAt === null;
  const activeFileCount = files.filter((f) => f.deletedAt === null).length;
  const hasReportData = reportData.length > 0;

  // Report entries split into two groups:
  //  - analysisData: run-level results not tied to a specific file (e.g. aggregated stats)
  //  - fileReportData: parsed output from individual files (e.g. per-file plate maps)
  const analysisData = reportData.filter((r) => r.fileId === null);
  const fileReportData = reportData.filter((r) => r.fileId !== null);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <RunHeader run={run}>
        {!isDeleted && (
          <DeleteRunDialog
            instrumentId={instrumentId}
            runId={runId}
            fileCount={activeFileCount}
            hasReportData={hasReportData}
          />
        )}
        {canRestore && (
          <RestoreRunButton instrumentId={instrumentId} runId={runId} />
        )}
      </RunHeader>

      <RunMetadata metadata={run.metadata as Record<string, unknown>} />

      <RunFilesSection
        files={files}
        instrumentId={instrumentId}
        runId={runId}
        isDeleted={isDeleted}
      />

      {fileReportData.length > 0 && (
        <RunReportSection reportData={fileReportData} files={files} />
      )}

      <RunAnalysisSection analysisData={analysisData} />
    </div>
  );
}
