import { RunAnalysisSection } from "@/components/runs/run-analysis-section";
import { RunFilesMetadataLayout } from "@/components/runs/run-files-metadata-layout";
import { RunFilesSection } from "@/components/runs/run-files-section";
import { RunHeader } from "@/components/runs/run-header";
import { RunMetadata } from "@/components/runs/run-metadata";
import { RunReportSection } from "@/components/runs/run-report-section";
import type {
  RawWellRow,
  RunDetail as RunDetailType,
  RunFile,
} from "@/lib/api/instrument-runs";

export const RunDetail = {
  Header: RunHeader,
  Metadata: RunMetadata,
  Files: RunFilesSection,
  FilesMetadataLayout: RunFilesMetadataLayout,
  Report: RunReportSection,
  Analysis: RunAnalysisSection,
};

export type RunDetailProps = {
  run: RunDetailType;
  files: RunFile[];
  wellData: RawWellRow[];
  instrumentId: string;
  runId: string;
};
