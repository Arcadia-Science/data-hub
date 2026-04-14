import { PlateMapGrid } from "@/components/runs/plate-map-grid";
import { ReportDataTable } from "@/components/runs/report-data-table";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RunFile, RunReportEntry } from "@/lib/api/instrument-runs";
import { AlertCircle } from "lucide-react";

export function FileProcessingErrors({ files }: { files: RunFile[] }) {
  const failedFiles = files.filter(
    (f) => f.status === "failed" && f.errorMessage
  );
  if (failedFiles.length === 0) return null;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Processing Errors</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {failedFiles.map((file) => (
          <Alert key={file.id} variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>{file.filename}</AlertTitle>
            <AlertDescription>{file.errorMessage}</AlertDescription>
          </Alert>
        ))}
      </CardContent>
    </Card>
  );
}

// Dispatches to a specialised renderer based on dataType. Plate maps get a
// visual grid; everything else falls through to a generic key/value table.
function ReportEntryRenderer({ entry }: { entry: RunReportEntry }) {
  if (entry.dataType === "plate_map") {
    return <PlateMapGrid data={entry.data} />;
  }
  return <ReportDataTable data={entry.data} />;
}

export function RunReportSection({
  reportData,
  files,
}: {
  reportData: RunReportEntry[];
  files: RunFile[];
}) {
  const hasFailedFiles = files.some(
    (f) => f.status === "failed" && f.errorMessage
  );

  if (reportData.length === 0 && !hasFailedFiles) {
    return (
      <Card size="sm">
        <CardHeader>
          <CardTitle>Report Data</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No report data has been generated for this run.
          </p>
        </CardContent>
      </Card>
    );
  }

  const fileMap = new Map(files.map((f) => [f.id, f]));

  const byFile = new Map<number, RunReportEntry[]>();
  for (const entry of reportData) {
    if (entry.fileId !== null) {
      const group = byFile.get(entry.fileId) ?? [];
      group.push(entry);
      byFile.set(entry.fileId, group);
    }
  }

  return (
    <>
      <FileProcessingErrors files={files} />

      {reportData.length > 0 && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>
              Report Data{" "}
              <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">
                {reportData.length} dataset(s)
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {Array.from(byFile.entries()).map(([fileId, entries]) => {
              const file = fileMap.get(fileId);
              return (
                <div key={fileId} className="flex flex-col gap-3">
                  <h3 className="text-sm font-medium">
                    {file?.filename ?? `File #${fileId}`}
                  </h3>
                  {entries.map((entry) => (
                    <div key={entry.id} className="flex flex-col gap-1.5">
                      <Badge
                        variant="outline"
                        className="w-fit font-mono text-[10px]"
                      >
                        {entry.dataType}
                      </Badge>
                      <ReportEntryRenderer entry={entry} />
                    </div>
                  ))}
                </div>
              );
            })}
          </CardContent>
        </Card>
      )}
    </>
  );
}
