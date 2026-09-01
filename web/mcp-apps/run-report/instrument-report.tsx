import { type ReactNode, useEffect, useMemo, useState } from "react";
import { AuntyPlateReport } from "@/components/runs/aunty/aunty-plate-report";
import { ImageCarouselReport } from "@/components/runs/image-carousel-report";
import { PdfCarouselReport } from "@/components/runs/pdf-carousel-report";
import {
  PlateMapGrid,
  PlateMapWithIndexSlider,
} from "@/components/runs/plate-map-grid";
import { QpcrMeltingReport } from "@/components/runs/qpcr/qpcr-melting-report";
import { RamanReportSection } from "@/components/runs/raman-report-section";
import { useReportDataSource } from "@/components/runs/report-data-source-provider";
import {
  ReportPersistKeyProvider,
  ReportViewerPageProvider,
} from "@/components/runs/report-items-provider";
import type { ReportSectionFile } from "@/components/runs/run-report-section";
import { RunReportSection } from "@/components/runs/run-report-section";
import { RunSectionCard } from "@/components/runs/run-section-card";
import { RunSectionHeading } from "@/components/runs/run-section-heading";
import { VideoCarouselReport } from "@/components/runs/video-carousel-report";
import type { RawWellRow } from "@/lib/api/instrument-runs";
import type { InstrumentType } from "@/lib/db/schema";
import { type AuntyPlateData, parseAuntyPlateJson } from "@/lib/runs/aunty";
import { extractPlateMaps } from "@/lib/runs/extract-plate-maps";
import {
  parseQpcrMeltingPlateJson,
  QPCR_MELTING_DERIVATIVES_SUFFIX,
  QPCR_MELTING_PLATE_SUFFIX,
  type QpcrMeltingPlateData,
} from "@/lib/runs/qpcr-melting";
import {
  emptyReportItemsPage,
  REPORT_ITEMS_WINDOW,
  type ReportItemKind,
  type ReportItemsPage,
  reportItemKindForInstrument,
} from "@/lib/runs/report-items";
import { isCsvFile, isPdfFile } from "@/lib/runs/run-file-types";
import type { ReportDataSource } from "@/lib/runs/view-data-source";
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

// Browser-side twin of `getAuntyPlateData`, which the web app runs on the
// server. Here the file bodies are read from S3 and skip the server entirely.
async function loadAuntyPlate(
  dataSource: ReportDataSource
): Promise<AuntyPlateData> {
  const resolveBySuffix = dataSource.resolveFileBySuffix;
  if (!resolveBySuffix) {
    throw new Error("This data source cannot resolve files by suffix.");
  }
  const plateRef = await resolveBySuffix("_aunty_plate.json");
  const response = await fetch(plateRef.url);
  if (!response.ok) {
    throw new Error(`Failed to load plate JSON (HTTP ${response.status})`);
  }
  const plate = parseAuntyPlateJson(await response.json());

  // An isothermal export has no curves file; the dialog then omits the chart.
  const curves = await resolveBySuffix("_aunty_curves.csv").catch(() => null);
  return { plate, curvesFileId: curves?.id ?? null };
}

async function loadQpcrMeltingPlate(
  dataSource: ReportDataSource
): Promise<QpcrMeltingPlateData | null> {
  const resolveBySuffix = dataSource.resolveFileBySuffix;
  if (!resolveBySuffix) {
    throw new Error("This data source cannot resolve files by suffix.");
  }
  try {
    const plateRef = await resolveBySuffix(QPCR_MELTING_PLATE_SUFFIX);
    const response = await fetch(plateRef.url);
    if (!response.ok) {
      throw new Error(`Failed to load plate JSON (HTTP ${response.status})`);
    }
    const plate = parseQpcrMeltingPlateJson(await response.json());
    const derivatives = await resolveBySuffix(
      QPCR_MELTING_DERIVATIVES_SUFFIX
    ).catch(() => null);
    return { plate, derivativesCsvFileId: derivatives?.id ?? null };
  } catch {
    return null;
  }
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
  if (instrumentType === "qpcr") {
    return <QpcrReport persistKey={persistKey} result={result} />;
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
    return (
      <ReportHeadingStatus>
        <p className="text-destructive text-sm">{error}</p>
      </ReportHeadingStatus>
    );
  }
  if (!page) {
    return (
      <ReportHeadingStatus>
        <p className="text-muted-foreground text-sm">Loading…</p>
      </ReportHeadingStatus>
    );
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
    void loadAuntyPlate(dataSource)
      .then(setPlate)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load plate");
      });
  }, [dataSource]);

  if (error) {
    return (
      <ReportHeadingStatus>
        <p className="text-destructive text-sm">{error}</p>
      </ReportHeadingStatus>
    );
  }
  if (!plate) {
    return (
      <ReportHeadingStatus>
        <p className="text-muted-foreground text-sm">Loading…</p>
      </ReportHeadingStatus>
    );
  }
  return (
    <AuntyPlateReport curvesFileId={plate.curvesFileId} plate={plate.plate} />
  );
}

// Plate grids first, then the instrument's PDF export under the "Report Data"
// title, matching the run page.
function QpcrReport({
  persistKey,
  result,
}: {
  persistKey: string;
  result: RunReportToolResult;
}) {
  const hasPdf = result.reportFiles.some(isPdfFile);
  return (
    <div className="flex w-full min-w-0 flex-col gap-8">
      <QpcrMeltingSection />
      {hasPdf ? (
        <CarouselKindReport kind="pdf" persistKey={persistKey}>
          <PdfCarouselReport />
        </CarouselKindReport>
      ) : (
        <RunReportSection files={toSectionFiles(result.reportFiles)} />
      )}
    </div>
  );
}

function QpcrMeltingSection() {
  const dataSource = useReportDataSource();
  const [plate, setPlate] = useState<QpcrMeltingPlateData | null | undefined>(
    undefined
  );

  useEffect(() => {
    void loadQpcrMeltingPlate(dataSource)
      .then(setPlate)
      .catch(() => setPlate(null));
  }, [dataSource]);

  if (!plate) {
    return null;
  }
  return (
    <QpcrMeltingReport
      derivativesCsvFileId={plate.derivativesCsvFileId}
      plate={plate.plate}
    />
  );
}

function PlateReaderReport({ result }: { result: RunReportToolResult }) {
  const dataSource = useReportDataSource();
  const [rows, setRows] = useState<RawWellRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const csv = firstProcessedCsv(result.reportFiles);

  useEffect(() => {
    if (!csv) {
      setRows([]);
      return;
    }
    void dataSource
      .fetchTableRows(csv.id)
      .then((table) => setRows(table.rows))
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
    return (
      <ReportHeadingStatus title="Plate Maps">
        <p className="text-destructive text-sm">{error}</p>
      </ReportHeadingStatus>
    );
  }
  if (rows === null) {
    return (
      <ReportHeadingStatus title="Plate Maps">
        <p className="text-muted-foreground text-sm">Loading…</p>
      </ReportHeadingStatus>
    );
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
      <div className="flex w-full min-w-0 flex-col gap-10">
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

function ReportHeadingStatus({
  children,
  title = "Report Data",
}: {
  children: ReactNode;
  title?: string;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <RunSectionHeading title={title} />
      {children}
    </div>
  );
}
