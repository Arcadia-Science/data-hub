import { ImageCarouselReport } from "@/components/runs/image-carousel-report";
import { PdfCarouselReport } from "@/components/runs/pdf-carousel-report";
import { RunFilesMetadataLayout } from "@/components/runs/run-files-metadata-layout";
import { RunFilesSection } from "@/components/runs/run-files-section";
import { RunHeader } from "@/components/runs/run-header";
import { RunMetadata } from "@/components/runs/run-metadata";
import { RunReportSection } from "@/components/runs/run-report-section";
import type {
  RawWellRow,
  RunDetail as RunDetailType,
  RunFile,
  RunFileStats,
  RunFilesPage,
} from "@/lib/api/instrument-runs";

export const RunDetail = {
  Header: RunHeader,
  Metadata: RunMetadata,
  Files: RunFilesSection,
  FilesMetadataLayout: RunFilesMetadataLayout,
  Report: RunReportSection,
  ImageCarousel: ImageCarouselReport,
  PdfCarousel: PdfCarouselReport,
};

export interface RunDetailProps {
  // Rendered in the summary card's "Ran By" field. Parent composes the
  // attribution UI so server-only user/session wiring stays at the page.
  attributionsSlot: React.ReactNode;
  // Aggregate per-run file counts (footer summary, variant counts).
  fileStats: RunFileStats;
  // Current page of the server-paginated files table.
  files: RunFile[];
  filesDownloadableCount: RunFilesPage["downloadableCount"];
  filesPagination: RunFilesPage["pagination"];
  instrumentId: string;
  // Processed + PDF files for the report sections and well-data parsing.
  reportFiles: RunFile[];
  // Images for the imaging-instrument carousel; empty for other instruments.
  reportImages: RunFile[];
  // PDFs for the TapeStation carousel; empty for other instruments.
  reportPdfs: RunFile[];
  run: RunDetailType;
  runId: string;
  // Previous/next run navigation for the header. Parent composes it so the
  // server-side neighbor lookup stays at the page, like `attributionsSlot`.
  runNavSlot: React.ReactNode;
  wellData: RawWellRow[];
}
