import { PlateMapGrid } from "@/components/runs/plate-map-grid";
import { ReportDataTable } from "@/components/runs/report-data-table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RunFile, RunReportEntry } from "@/lib/api/instrument-runs";

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
  if (reportData.length === 0) {
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

  // Report entries are grouped for display:
  //  - runLevel: aggregate results computed across all files (fileId is null)
  //  - byFile: per-file parsed output, keyed by file ID for collapsible sections
  const runLevel = reportData.filter((r) => r.fileId === null);
  const byFile = new Map<number, RunReportEntry[]>();
  for (const entry of reportData) {
    if (entry.fileId !== null) {
      const group = byFile.get(entry.fileId) ?? [];
      group.push(entry);
      byFile.set(entry.fileId, group);
    }
  }

  return (
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
        {runLevel.length > 0 && (
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium">Run Analysis</h3>
            {runLevel.map((entry) => (
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
        )}

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
  );
}
