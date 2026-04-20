import { DeleteRunDialog } from "@/components/runs/delete-run-dialog";
import {
  KineticPlateMapWithTimeSlider,
  PlateMapGrid,
  type PlateWellData,
} from "@/components/runs/plate-map-grid";
import { RestoreRunButton } from "@/components/runs/restore-run-button";
import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import { PlateReaderRunBadges } from "@/components/runs/run-metadata-badges";
import { Card, CardContent } from "@/components/ui/card";
import type { RawWellRow } from "@/lib/api/instrument-runs";

/** Measurement types whose well values are numeric and benefit from color-coded heatmaps. */
const HEATMAP_MEASUREMENT_TYPES = new Set(["Endpoint", "Well Scan", "Kinetic"]);

/**
 * CSV parsing (csv-parse) returns all cell values as strings. The heatmap grid
 * relies on `typeof value === "number"` to apply the Plasma colorscale, so we
 * coerce numeric-looking strings (e.g. "0.649") to real numbers at the
 * PlateWellData boundary.
 */
function coerceNumeric(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value !== "string" || value === "") return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

type PlateMapGroup =
  | {
      mode: "static";
      plateName: string;
      wavelength: string;
      wells: PlateWellData[];
    }
  | {
      mode: "kinetic";
      plateName: string;
      wavelength: string;
      timeLabels: string[];
      frames: PlateWellData[][];
    };

/**
 * Sort time-point keys so kinetic slider frames appear in chronological order.
 * Numeric timestamps (e.g. seconds) are sorted numerically; non-numeric labels
 * fall back to locale-aware natural sort.
 */
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

function buildPlateWaveParts(
  plate: string,
  wavelength: string
): { plateName: string; wavelength: string } {
  return { plateName: plate, wavelength };
}

/**
 * Groups kinetic CSV rows into time-indexed plate map frames, one group per
 * unique plate + wavelength combination. Each group becomes either a single
 * static plate map (if only one time-point exists) or a kinetic slider with
 * one frame per time-point.
 */
function extractKineticPlateMapGroups(
  rows: RawWellRow[],
  wellKey: "well_position" | "well"
): PlateMapGroup[] {
  // First pass: bucket rows by plate + wavelength.
  const byPlateWave = new Map<string, RawWellRow[]>();
  for (const row of rows) {
    const pw = `${row.plate_name ?? ""}|${row.wavelength ?? ""}`;
    const arr = byPlateWave.get(pw) ?? [];
    arr.push(row);
    byPlateWave.set(pw, arr);
  }

  const results: PlateMapGroup[] = [];
  for (const [pw, subset] of byPlateWave) {
    // Second pass within each plate+wavelength: bucket by time-point.
    const byTime = new Map<string, RawWellRow[]>();
    for (const row of subset) {
      const tk = String(row.time ?? "");
      const g = byTime.get(tk) ?? [];
      g.push(row);
      byTime.set(tk, g);
    }

    const [plate = "", wavelength = ""] = pw.split("|");
    const parts = buildPlateWaveParts(plate, wavelength);

    // Only one time-point — degenerate to a static map instead of a slider.
    if (byTime.size < 2) {
      const flat = [...byTime.values()].flat();
      results.push({
        mode: "static",
        ...parts,
        wells: flat.map((r) => ({
          well: String(r[wellKey]),
          value: coerceNumeric(r.value),
        })),
      });
      continue;
    }

    const timeKeysSorted = sortTimeKeys([...byTime.keys()]);
    const frames = timeKeysSorted.map((tk) =>
      byTime.get(tk)!.map((r) => ({
        well: String(r[wellKey]),
        value: coerceNumeric(r.value),
      }))
    );
    results.push({
      mode: "kinetic",
      ...parts,
      timeLabels: timeKeysSorted,
      frames,
    });
  }
  return results;
}

/**
 * Main entry point: converts flat CSV rows into renderable plate map groups.
 *
 * Strategy depends on measurement type:
 *  - Kinetic with multiple time-points → time-slider groups (one per plate+wavelength)
 *  - Single combination of (plate, wavelength, time) → one unlabelled static map
 *  - Multiple combinations → separate labelled static maps (e.g. multi-wavelength endpoint)
 *
 * The CSV may use either "well_position" (SpectraMax) or "well" as the column
 * name for well coordinates — we auto-detect from the first row.
 */
function extractPlateMaps(
  rows: RawWellRow[],
  options: { kinetic: boolean }
): PlateMapGroup[] {
  if (rows.length === 0) return [];

  // Auto-detect the well-address column name across CSV export formats.
  const wellKey =
    rows[0].well_position !== undefined ? "well_position" : "well";
  if (rows[0][wellKey] === undefined) return [];

  const uniqueTimes = new Set(rows.map((r) => String(r.time ?? "")));
  const hasTimeVariation = uniqueTimes.size > 1;

  if (options.kinetic && hasTimeVariation) {
    return extractKineticPlateMapGroups(
      rows,
      wellKey as "well_position" | "well"
    );
  }

  // Check whether all rows belong to the same (plate, wavelength, time) group.
  const hasMultiple =
    new Set(rows.map((r) => `${r.plate_name}|${r.wavelength}|${r.time}`)).size >
    1;

  if (!hasMultiple) {
    return [
      {
        mode: "static",
        plateName: "",
        wavelength: "",
        wells: rows.map((r) => ({
          well: String(r[wellKey]),
          value: coerceNumeric(r.value),
        })),
      },
    ];
  }

  // Multiple groups — split by (plate, wavelength, time) and label each one.
  const grouped = new Map<string, RawWellRow[]>();
  for (const row of rows) {
    const key = `${row.plate_name ?? ""}|${row.wavelength ?? ""}|${row.time ?? ""}`;
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }

  return Array.from(grouped.entries()).map(([key, group]) => {
    const [plate = "", wavelength = "", time = ""] = key.split("|");
    const titleParts: string[] = [];
    if (plate) titleParts.push(plate);
    if (time) titleParts.push(`t=${time}`);
    return {
      mode: "static" as const,
      plateName: titleParts.join(" · "),
      wavelength,
      wells: group.map((r) => ({
        well: String(r[wellKey]),
        value: coerceNumeric(r.value),
      })),
    };
  });
}

function PlateMapSection({
  rows,
  heatmap,
  kineticLayout,
}: {
  rows: RawWellRow[];
  heatmap: boolean;
  kineticLayout: boolean;
}) {
  const groups = extractPlateMaps(rows, { kinetic: kineticLayout });

  if (groups.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">
        Plate Maps{" "}
        <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">
          {groups.length} map(s)
        </span>
      </h2>
      <Card size="sm">
        <CardContent className="flex flex-col gap-6">
          <div className="flex flex-col gap-10">
            {groups.map((g, i) =>
              g.mode === "kinetic" ? (
                <KineticPlateMapWithTimeSlider
                  key={i}
                  timeLabels={g.timeLabels}
                  frames={g.frames}
                  heatmap={heatmap}
                  plateName={g.plateName}
                  wavelength={g.wavelength}
                />
              ) : (
                <PlateMapGrid
                  key={i}
                  data={g.wells}
                  heatmap={heatmap}
                  plateName={g.plateName}
                  wavelength={g.wavelength}
                />
              )
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function PlateReaderRunDetail({
  run,
  files,
  wellData,
  instrumentId,
  runId,
}: RunDetailProps) {
  const isDeleted = run.deletedAt !== null;
  const canRestore = isDeleted && run.filesPurgedAt === null;
  const activeFileCount = files.filter((f) => f.deletedAt === null).length;
  const hasProcessedFiles =
    files.filter((f) => f.category === "processed" && f.deletedAt === null)
      .length > 0;

  const metadata = run.metadata as Record<string, unknown>;
  const measurementType =
    typeof metadata.measurement_type === "string"
      ? metadata.measurement_type
      : "";
  // Enable heatmap coloring if the measurement type is known-numeric, or if
  // any well value looks numeric (handles runs where measurement_type metadata
  // was not captured by the ingestion pipeline).
  const heatmap =
    HEATMAP_MEASUREMENT_TYPES.has(measurementType) ||
    wellData.some((r) => Number.isFinite(Number(r.value)));

  return (
    <>
      <RunDetail.Header run={run}>
        {!isDeleted && (
          <DeleteRunDialog
            instrumentId={instrumentId}
            runId={runId}
            fileCount={activeFileCount}
            hasProcessedFiles={hasProcessedFiles}
          />
        )}
        {canRestore && (
          <RestoreRunButton instrumentId={instrumentId} runId={runId} />
        )}
      </RunDetail.Header>

      <RunDetail.FilesMetadataLayout>
        <RunDetail.Metadata metadata={run.metadata as Record<string, unknown>}>
          <PlateReaderRunBadges
            metadata={run.metadata as Record<string, unknown>}
          />
        </RunDetail.Metadata>
        <RunDetail.Files
          files={files}
          instrumentId={instrumentId}
          runId={runId}
          isDeleted={isDeleted}
        />
      </RunDetail.FilesMetadataLayout>

      <PlateMapSection
        rows={wellData}
        heatmap={heatmap}
        kineticLayout={measurementType === "Kinetic"}
      />

      <RunDetail.Analysis />
    </>
  );
}
