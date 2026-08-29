import { type ReactNode, useEffect, useMemo, useState } from "react";
import { AuntyPlateReport } from "@/components/runs/aunty/aunty-plate-report";
import { ImageCarouselReport } from "@/components/runs/image-carousel-report";
import { PdfCarouselReport } from "@/components/runs/pdf-carousel-report";
import {
  PlateMapGrid,
  PlateMapWithIndexSlider,
} from "@/components/runs/plate-map-grid";
import { RamanReportSection } from "@/components/runs/raman-report-section";
import { useReportDataSource } from "@/components/runs/report-data-source-provider";
import {
  ReportPersistKeyProvider,
  ReportViewerPageProvider,
} from "@/components/runs/report-items-provider";
import type { ReportSectionFile } from "@/components/runs/run-report-section";
import { RunReportSection } from "@/components/runs/run-report-section";
import { RunSectionCard } from "@/components/runs/run-section-card";
import { VideoCarouselReport } from "@/components/runs/video-carousel-report";
import type { RawWellRow } from "@/lib/api/instrument-runs";
import type { InstrumentType } from "@/lib/db/schema";
import type { AuntyPlateData } from "@/lib/runs/aunty";
import { extractPlateMaps } from "@/lib/runs/extract-plate-maps";
import {
  emptyReportItemsPage,
  REPORT_ITEMS_WINDOW,
  type ReportItemKind,
  type ReportItemsPage,
  reportItemKindForInstrument,
} from "@/lib/runs/report-items";
import { fetchAllTableRows } from "@/lib/runs/report-table";
import { isCsvFile } from "@/lib/runs/run-file-types";
import { readPersistedFileId } from "./host-bridge";

interface ReportFileRef {
  category: string;
  contentType: string | null;
  filename: string;
  id: number;
}

export interface RunReportToolResult {
  instrumentId: string;
  instrumentType: string;
  metadata: unknown;
  reportFiles: ReportFileRef[];
  runId: string;
}

const HEATMAP_MEASUREMENT_TYPES = new Set([
  "Endpoint",
  "Well Scan",
  "Kinetic",
  "Spectrum",
]);

function asInstrumentType(value: string): InstrumentType {
  return value as InstrumentType;
}

function toSectionFiles(files: ReportFileRef[]): ReportSectionFile[] {
  return files.map((file) => ({
    id: file.id,
    filename: file.filename,
    category: file.category === "processed" ? "processed" : "raw",
    contentType: file.contentType,
    deletedAt: null,
  }));
}

function firstProcessedCsv(files: ReportFileRef[]): ReportFileRef | undefined {
  return files.find((file) => file.category === "processed" && isCsvFile(file));
}

function isAuntyPlateData(value: unknown): value is AuntyPlateData {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return "plate" in value;
}

export function InstrumentReport({
  persistKey,
  result,
}: {
  persistKey: string;
  result: RunReportToolResult;
}) {
  const instrumentType = asInstrumentType(result.instrumentType);
  const kind = reportItemKindForInstrument(instrumentType);

  if (
    kind === "image" &&
    (instrumentType === "gel_doc" || instrumentType === "hina_microscope")
  ) {
    return (
      <CarouselKindReport kind={kind} persistKey={persistKey}>
        <ImageCarouselReport />
      </CarouselKindReport>
    );
  }
  if (kind === "pdf" && instrumentType === "tape_station") {
    return (
      <CarouselKindReport kind={kind} persistKey={persistKey}>
        <PdfCarouselReport />
      </CarouselKindReport>
    );
  }
  if (kind === "video" && instrumentType === "dishcam") {
    return (
      <CarouselKindReport kind={kind} persistKey={persistKey}>
        <VideoCarouselReport />
      </CarouselKindReport>
    );
  }
  if (kind === "spectrum" && instrumentType === "instant_raman") {
    return (
      <CarouselKindReport kind={kind} persistKey={persistKey}>
        <RamanReportSection />
      </CarouselKindReport>
    );
  }
  if (instrumentType === "aunty") {
    return <AuntyReport />;
  }
  if (instrumentType === "plate_reader") {
    return <PlateReaderReport result={result} />;
  }

  return <RunReportSection files={toSectionFiles(result.reportFiles)} />;
}

function CarouselKindReport({
  kind,
  persistKey,
  children,
}: {
  children: ReactNode;
  kind: ReportItemKind;
  persistKey: string;
}) {
  const dataSource = useReportDataSource();
  const [page, setPage] = useState<ReportItemsPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const anchor = readPersistedFileId(persistKey);
    void dataSource
      .fetchReportItems({
        kind,
        offset: 0,
        limit: REPORT_ITEMS_WINDOW,
        anchor,
      })
      .then(setPage)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load items");
        setPage(emptyReportItemsPage());
      });
  }, [dataSource, kind, persistKey]);

  if (error) {
    return <p className="text-destructive text-sm">{error}</p>;
  }
  if (!page) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  return (
    <ReportPersistKeyProvider persistKey={persistKey}>
      <ReportViewerPageProvider page={page}>
        {children}
      </ReportViewerPageProvider>
    </ReportPersistKeyProvider>
  );
}

function AuntyReport() {
  const dataSource = useReportDataSource();
  const [plate, setPlate] = useState<AuntyPlateData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void dataSource
      .fetchArtifact({ suffix: "_aunty_plate.json" })
      .then((artifact) => {
        if (isAuntyPlateData(artifact)) {
          setPlate(artifact);
          return;
        }
        setError("Aunty plate artifact had an unexpected shape.");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load plate");
      });
  }, [dataSource]);

  if (error) {
    return <p className="text-destructive text-sm">{error}</p>;
  }
  if (!plate) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  return (
    <AuntyPlateReport curvesFileId={plate.curvesFileId} plate={plate.plate} />
  );
}

function PlateReaderReport({ result }: { result: RunReportToolResult }) {
  const dataSource = useReportDataSource();
  const [rows, setRows] = useState<RawWellRow[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const csv = firstProcessedCsv(result.reportFiles);

  useEffect(() => {
    if (!csv) {
      setRows([]);
      return;
    }
    void fetchAllTableRows(dataSource, csv.id)
      .then((table) => {
        setRows(table.rows ?? []);
        setTruncated(table.truncated);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load wells");
        setRows([]);
      });
  }, [csv, dataSource]);

  const metadata =
    result.metadata && typeof result.metadata === "object"
      ? (result.metadata as Record<string, unknown>)
      : {};
  const measurementType =
    typeof metadata.measurement_type === "string"
      ? metadata.measurement_type
      : "";

  const heatmap = useMemo(
    () =>
      HEATMAP_MEASUREMENT_TYPES.has(measurementType) ||
      (rows ?? []).some((row) => Number.isFinite(Number(row.value))),
    [measurementType, rows]
  );
  const groups = useMemo(
    () =>
      extractPlateMaps(rows ?? [], {
        kinetic: measurementType === "Kinetic",
        spectrum: measurementType === "Spectrum",
      }),
    [measurementType, rows]
  );

  if (error) {
    return <p className="text-destructive text-sm">{error}</p>;
  }
  if (rows === null) {
    return <p className="text-muted-foreground text-sm">Loading…</p>;
  }
  if (rows.length === 0 || groups.length === 0) {
    return (
      <RunSectionCard title="Plate Maps">
        <p className="text-muted-foreground text-sm">
          No report data has been generated for this run.
        </p>
      </RunSectionCard>
    );
  }

  return (
    <RunSectionCard
      className="min-w-0"
      contentClassName="min-w-0"
      count={groups.length}
      title="Plate Maps"
    >
      {truncated ? (
        <p className="text-muted-foreground text-xs">
          This file is larger than the report can load. The maps use the first
          rows only.
        </p>
      ) : null}
      <div className="flex min-w-0 flex-col gap-10">
        {groups.map((group, index) =>
          group.mode === "kinetic" ? (
            <PlateMapWithIndexSlider
              frameLabels={group.frameLabels}
              frames={group.frames}
              heatmap={heatmap}
              key={`${group.plateName}-${index}`}
              plateName={group.plateName}
              sliderAxis={group.sliderAxis}
              wavelength={group.wavelength}
            />
          ) : (
            <PlateMapGrid
              data={group.wells}
              heatmap={heatmap}
              key={`${group.plateName}-${index}`}
              plateName={group.plateName}
              wavelength={group.wavelength}
            />
          )
        )}
      </div>
    </RunSectionCard>
  );
}
