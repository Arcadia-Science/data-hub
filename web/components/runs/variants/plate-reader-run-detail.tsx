import {
  PlateMapGrid,
  PlateMapWithIndexSlider,
} from "@/components/runs/plate-map-grid";
import type { RunDetailProps } from "@/components/runs/run-detail";
import { RunDetailLayout } from "@/components/runs/run-detail-layout";
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

// How a measurement type lays out its wells. Kinetic and Spectrum runs hold a
// series of frames behind a slider, and everything else is one plate.
type PlateLayout = "single" | "kinetic" | "spectrum";

function plateLayoutFor(measurementType: string): PlateLayout {
  if (measurementType === "Kinetic") {
    return "kinetic";
  }
  return measurementType === "Spectrum" ? "spectrum" : "single";
}

function PlateMapSection({
  rows,
  heatmap,
  layout,
}: {
  rows: RawWellRow[];
  heatmap: boolean;
  layout: PlateLayout;
}) {
  const groups = extractPlateMaps(rows, {
    kinetic: layout === "kinetic",
    spectrum: layout === "spectrum",
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
      <div className="flex w-full min-w-0 flex-col gap-10">
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

export function PlateReaderRunDetail(props: RunDetailProps) {
  const { wellData } = props;
  const metadata = props.run.metadata as Record<string, unknown>;
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
    <RunDetailLayout
      {...props}
      badges={
        hasPlateReaderMetadata(metadata) ? (
          <PlateReaderRunBadges metadata={metadata} />
        ) : null
      }
    >
      <PlateMapSection
        heatmap={heatmap}
        layout={plateLayoutFor(measurementType)}
        rows={wellData}
      />
    </RunDetailLayout>
  );
}
