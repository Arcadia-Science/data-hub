import { DeleteRunDialog } from "@/components/runs/delete-run-dialog";
import { PlateMapGrid } from "@/components/runs/plate-map-grid";
import { ReportDataTable } from "@/components/runs/report-data-table";
import { RestoreRunButton } from "@/components/runs/restore-run-button";
import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RunFile, RunReportEntry } from "@/lib/api/instrument-runs";

function PlateMapSection({
  entries,
  files,
}: {
  entries: RunReportEntry[];
  files: RunFile[];
}) {
  const fileMap = new Map(files.map((f) => [f.id, f]));

  const byFile = new Map<number | null, RunReportEntry[]>();
  for (const entry of entries) {
    const key = entry.fileId;
    const group = byFile.get(key) ?? [];
    group.push(entry);
    byFile.set(key, group);
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          Plate Maps{" "}
          <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">
            {entries.length} map(s)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {Array.from(byFile.entries()).map(([fileId, maps]) => {
          const file = fileId !== null ? fileMap.get(fileId) : undefined;
          return (
            <div key={fileId ?? "run-level"} className="flex flex-col gap-3">
              {file && <h3 className="text-sm font-medium">{file.filename}</h3>}
              {maps.map((entry) => (
                <PlateMapGrid key={entry.id} data={entry.data} />
              ))}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function OtherReportData({
  entries,
  files,
}: {
  entries: RunReportEntry[];
  files: RunFile[];
}) {
  if (entries.length === 0) return null;

  const fileMap = new Map(files.map((f) => [f.id, f]));

  const byFile = new Map<number | null, RunReportEntry[]>();
  for (const entry of entries) {
    const key = entry.fileId;
    const group = byFile.get(key) ?? [];
    group.push(entry);
    byFile.set(key, group);
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          Other Report Data{" "}
          <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">
            {entries.length} dataset(s)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {Array.from(byFile.entries()).map(([fileId, items]) => {
          const file = fileId !== null ? fileMap.get(fileId) : undefined;
          return (
            <div key={fileId ?? "run-level"} className="flex flex-col gap-3">
              {file && <h3 className="text-sm font-medium">{file.filename}</h3>}
              {items.map((entry) => (
                <div key={entry.id} className="flex flex-col gap-1.5">
                  <Badge
                    variant="outline"
                    className="w-fit font-mono text-[10px]"
                  >
                    {entry.dataType}
                  </Badge>
                  <ReportDataTable data={entry.data} />
                </div>
              ))}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

export function PlateReaderRunDetail({
  run,
  files,
  reportData,
  instrumentId,
  runId,
}: RunDetailProps) {
  const isDeleted = run.deletedAt !== null;
  const canRestore = isDeleted && run.filesPurgedAt === null;
  const activeFileCount = files.filter((f) => f.deletedAt === null).length;
  const hasReportData = reportData.length > 0;

  const analysisData = reportData.filter((r) => r.fileId === null);
  const fileReportData = reportData.filter((r) => r.fileId !== null);

  const plateMapEntries = fileReportData.filter(
    (r) => r.dataType === "plate_map"
  );
  const otherEntries = fileReportData.filter((r) => r.dataType !== "plate_map");

  return (
    <>
      <RunDetail.Header run={run}>
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
      </RunDetail.Header>

      <RunDetail.Metadata metadata={run.metadata as Record<string, unknown>} />

      <RunDetail.Files
        files={files}
        instrumentId={instrumentId}
        runId={runId}
        isDeleted={isDeleted}
      />

      {plateMapEntries.length > 0 && (
        <PlateMapSection entries={plateMapEntries} files={files} />
      )}

      <OtherReportData entries={otherEntries} files={files} />

      <RunDetail.Analysis analysisData={analysisData} />
    </>
  );
}
