import { DeleteRunDialog } from "@/components/runs/delete-run-dialog";
import {
  PlateMapGrid,
  PlateMapWithIndexSlider,
} from "@/components/runs/plate-map-grid";
import { RestoreRunButton } from "@/components/runs/restore-run-button";
import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetail } from "@/components/runs/run-detail";
import {
  hasPlateReaderMetadata,
  PlateReaderRunBadges,
} from "@/components/runs/run-metadata-badges";
import { RunSectionCard } from "@/components/runs/run-section-card";
import type { RawWellRow } from "@/lib/api/instrument-runs";
import { extractPlateMaps } from "@/lib/runs/extract-plate-maps";

/** Measurement types whose well values are numeric and benefit from color-coded heatmaps. */
const HEATMAP_MEASUREMENT_TYPES = new Set([
  "Endpoint",
  "Well Scan",
  "Kinetic",
  "Spectrum",
]);

function PlateMapSection({
  rows,
  heatmap,
  kineticLayout,
  spectrumLayout,
}: {
  rows: RawWellRow[];
  heatmap: boolean;
  kineticLayout: boolean;
  spectrumLayout: boolean;
}) {
  const groups = extractPlateMaps(rows, {
    kinetic: kineticLayout,
    spectrum: spectrumLayout,
  });

  if (groups.length === 0) {
    return null;
  }

  return (
    <RunSectionCard
      className="min-w-0"
      contentClassName="min-w-0"
      count={groups.length}
      title="Plate Maps"
    >
      <div className="flex min-w-0 flex-col gap-10">
        {groups.map((g, i) =>
          g.mode === "kinetic" ? (
            <PlateMapWithIndexSlider
              frameLabels={g.frameLabels}
              frames={g.frames}
              heatmap={heatmap}
              key={i}
              plateName={g.plateName}
              sliderAxis={g.sliderAxis}
              wavelength={g.wavelength}
            />
          ) : (
            <PlateMapGrid
              data={g.wells}
              heatmap={heatmap}
              key={i}
              plateName={g.plateName}
              wavelength={g.wavelength}
            />
          )
        )}
      </div>
    </RunSectionCard>
  );
}

export function PlateReaderRunDetail({
  run,
  files,
  filesDownloadableCount,
  filesPagination,
  fileStats,
  wellData,
  instrumentId,
  runId,
  attributionsSlot,
  runNavSlot,
}: RunDetailProps) {
  const isDeleted = run.deletedAt !== null;
  const activeFileCount = fileStats.active;
  const hasProcessedFiles = fileStats.processedActive > 0;

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
      <RunDetail.Header run={run} runNavSlot={runNavSlot}>
        {!isDeleted && (
          <DeleteRunDialog
            fileCount={activeFileCount}
            hasProcessedFiles={hasProcessedFiles}
            instrumentId={instrumentId}
            runId={runId}
          />
        )}
        {isDeleted && (
          <RestoreRunButton instrumentId={instrumentId} runId={runId} />
        )}
      </RunDetail.Header>

      <RunDetail.FilesMetadataLayout>
        <RunDetail.Metadata
          attributionsSlot={attributionsSlot}
          fileStats={fileStats}
          run={run}
        >
          {hasPlateReaderMetadata(run.metadata as Record<string, unknown>) && (
            <PlateReaderRunBadges
              metadata={run.metadata as Record<string, unknown>}
            />
          )}
        </RunDetail.Metadata>
        <RunDetail.Files
          files={files}
          filteredDownloadableCount={filesDownloadableCount}
          instrumentId={instrumentId}
          instrumentType={run.instrumentType}
          isDeleted={isDeleted}
          pagination={filesPagination}
          runId={runId}
          stats={fileStats}
        />
      </RunDetail.FilesMetadataLayout>

      <PlateMapSection
        heatmap={heatmap}
        kineticLayout={measurementType === "Kinetic"}
        rows={wellData}
        spectrumLayout={measurementType === "Spectrum"}
      />
    </>
  );
}
