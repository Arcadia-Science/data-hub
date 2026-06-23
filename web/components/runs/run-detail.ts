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
};

export interface RunDetailProps {
  // Rendered below the header on every variant. Parent composes the
  // attribution UI so server-only user/session wiring stays at the page.
  attributionsSlot: React.ReactNode;
  // Aggregate per-run file counts (footer summary, variant counts).
  fileStats: RunFileStats;
  // Current page of the server-paginated files table.
  files: RunFile[];
  filesPagination: RunFilesPage["pagination"];
  instrumentId: string;
  // Processed + PDF files for the report sections and well-data parsing.
  reportFiles: RunFile[];
  run: RunDetailType;
  runId: string;
  wellData: RawWellRow[];
}
