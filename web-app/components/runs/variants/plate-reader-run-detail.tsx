import { DeleteRunDialog } from "@/components/runs/delete-run-dialog";
import {
  KineticPlateMapWithTimeSlider,
  PlateMapGrid,
  type PlateWellData,
} from "@/components/runs/plate-map-grid";
import { FileProcessingErrors } from "@/components/runs/run-report-section";
import { ReportDataTable } from "@/components/runs/report-data-table";
import { RestoreRunButton } from "@/components/runs/restore-run-button";
import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RunReportEntry } from "@/lib/api/instrument-runs";

const PLATE_MAP_DATA_TYPES = new Set(["plate_map", "raw_well_data"]);

const HEATMAP_MEASUREMENT_TYPES = new Set(["Endpoint", "Well Scan", "Kinetic"]);

type RawWellRow = Record<string, unknown> & {
  well_position?: string;
  well?: string;
  value?: unknown;
};

type PlateMapGroup =
  | { mode: "static"; label: string; wells: PlateWellData[] }
  | {
      mode: "kinetic";
      label: string;
      timeLabels: string[];
      frames: PlateWellData[][];
    };

function sortTimeKeys(keys: string[]): string[] {
  const unique = [...new Set(keys)];
  const allNumeric = unique.every((k) => {
    if (k === "") return false;
    return Number.isFinite(Number(k));
  });
  if (allNumeric) {
    return unique.sort((a, b) => Number(a) - Number(b));
  }
  return unique.sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true })
  );
}

function buildPlateWaveLabel(plate: string, wavelength: string): string {
  const parts: string[] = [];
  if (plate) parts.push(plate);
  if (wavelength) parts.push(`${wavelength} nm`);
  return parts.join(" · ");
}

function extractKineticPlateMapGroups(
  rows: RawWellRow[],
  wellKey: "well_position" | "well"
): PlateMapGroup[] {
  const byPlateWave = new Map<string, RawWellRow[]>();
  for (const row of rows) {
    const pw = `${row.plate_name ?? ""}|${row.wavelength ?? ""}`;
    const arr = byPlateWave.get(pw) ?? [];
    arr.push(row);
    byPlateWave.set(pw, arr);
  }

  const results: PlateMapGroup[] = [];
  for (const [pw, subset] of byPlateWave) {
    const byTime = new Map<string, RawWellRow[]>();
    for (const row of subset) {
      const tk = String(row.time ?? "");
      const g = byTime.get(tk) ?? [];
      g.push(row);
      byTime.set(tk, g);
    }

    const [plate = "", wavelength = ""] = pw.split("|");
    const label = buildPlateWaveLabel(plate, wavelength);

    if (byTime.size < 2) {
      const flat = [...byTime.values()].flat();
      results.push({
        mode: "static",
        label,
        wells: flat.map((r) => ({
          well: String(r[wellKey]),
          value: r.value,
        })),
      });
      continue;
    }

    const timeKeysSorted = sortTimeKeys([...byTime.keys()]);
    const frames = timeKeysSorted.map((tk) =>
      byTime.get(tk)!.map((r) => ({
        well: String(r[wellKey]),
        value: r.value,
      }))
    );
    results.push({
      mode: "kinetic",
      label,
      timeLabels: timeKeysSorted,
      frames,
    });
  }
  return results;
}

function extractPlateMaps(
  entry: RunReportEntry,
  options: { kinetic: boolean }
): PlateMapGroup[] {
  if (!Array.isArray(entry.data)) return [];
  const rows = entry.data as RawWellRow[];
  if (rows.length === 0) return [];

  if (entry.dataType === "plate_map") {
    return [
      {
        mode: "static",
        label: "",
        wells: rows as PlateWellData[],
      },
    ];
  }

  // raw_well_data: rows have well_position + value, possibly varying by
  // plate_name / wavelength / time. Group into one grid per combination.
  const wellKey =
    rows[0].well_position !== undefined ? "well_position" : "well";
  if (rows[0][wellKey] === undefined) return [];

  const uniqueTimes = new Set(rows.map((r) => String(r.time ?? "")));
  const hasTimeVariation = uniqueTimes.size > 1;

  if (options.kinetic && hasTimeVariation) {
    return extractKineticPlateMapGroups(rows, wellKey);
  }

  const hasMultiple =
    new Set(rows.map((r) => `${r.plate_name}|${r.wavelength}|${r.time}`)).size >
    1;

  if (!hasMultiple) {
    return [
      {
        mode: "static",
        label: "",
        wells: rows.map((r) => ({
          well: String(r[wellKey]),
          value: r.value,
        })),
      },
    ];
  }

  const grouped = new Map<string, RawWellRow[]>();
  for (const row of rows) {
    const key = `${row.plate_name ?? ""}|${row.wavelength ?? ""}|${row.time ?? ""}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }

  return Array.from(grouped.entries()).map(([key, group]) => {
    const [plate, wavelength, time] = key.split("|");
    const parts: string[] = [];
    if (plate) parts.push(plate);
    if (wavelength) parts.push(`${wavelength} nm`);
    if (time) parts.push(`t=${time}`);
    return {
      mode: "static" as const,
      label: parts.join(" · "),
      wells: group.map((r) => ({
        well: String(r[wellKey]),
        value: r.value,
      })),
    };
  });
}

function PlateMapSection({
  entries,
  heatmap,
  kineticLayout,
}: {
  entries: RunReportEntry[];
  heatmap: boolean;
  kineticLayout: boolean;
}) {
  const byFile = new Map<number | null, RunReportEntry[]>();
  for (const entry of entries) {
    const group = byFile.get(entry.fileId) ?? [];
    group.push(entry);
    byFile.set(entry.fileId, group);
  }

  let totalMaps = 0;
  const sections = Array.from(byFile.entries()).map(([fileId, fileEntries]) => {
    const groups = fileEntries.flatMap((e) =>
      extractPlateMaps(e, { kinetic: kineticLayout })
    );
    totalMaps += groups.length;
    return { fileId, groups };
  });

  if (totalMaps === 0) return null;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          Plate Maps{" "}
          <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">
            {totalMaps} map(s)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {sections.map(({ fileId, groups }) => (
          <div key={fileId ?? "run-level"} className="flex flex-col gap-10">
            {groups.map((g, i) => (
              <div key={i} className="flex flex-col gap-2">
                {g.label && (
                  <h4 className="font-mono text-sm leading-snug font-medium text-foreground">
                    {g.label}
                  </h4>
                )}
                {g.mode === "kinetic" ? (
                  <KineticPlateMapWithTimeSlider
                    timeLabels={g.timeLabels}
                    frames={g.frames}
                    heatmap={heatmap}
                  />
                ) : (
                  <PlateMapGrid data={g.wells} heatmap={heatmap} />
                )}
              </div>
            ))}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function OtherReportData({ entries }: { entries: RunReportEntry[] }) {
  if (entries.length === 0) return null;

  const byFile = new Map<number | null, RunReportEntry[]>();
  for (const entry of entries) {
    const group = byFile.get(entry.fileId) ?? [];
    group.push(entry);
    byFile.set(entry.fileId, group);
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
          return (
            <div key={fileId ?? "run-level"} className="flex flex-col gap-3">
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

  const metadata = run.metadata as Record<string, unknown>;
  const measurementType =
    typeof metadata.measurement_type === "string"
      ? metadata.measurement_type
      : "";
  const heatmap = HEATMAP_MEASUREMENT_TYPES.has(measurementType);

  const analysisData = reportData.filter((r) => r.fileId === null);
  const fileReportData = reportData.filter((r) => r.fileId !== null);

  const plateMapEntries = fileReportData.filter((r) =>
    PLATE_MAP_DATA_TYPES.has(r.dataType)
  );
  const otherEntries = fileReportData.filter(
    (r) => !PLATE_MAP_DATA_TYPES.has(r.dataType)
  );

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

      <RunDetail.FilesMetadataLayout>
        <RunDetail.Files
          files={files}
          instrumentId={instrumentId}
          runId={runId}
          isDeleted={isDeleted}
        />
        <RunDetail.Metadata
          metadata={run.metadata as Record<string, unknown>}
        />
      </RunDetail.FilesMetadataLayout>

      <FileProcessingErrors files={files} />

      <PlateMapSection
        entries={plateMapEntries}
        heatmap={heatmap}
        kineticLayout={measurementType === "Kinetic"}
      />

      <OtherReportData entries={otherEntries} />

      <RunDetail.Analysis analysisData={analysisData} />
    </>
  );
}
