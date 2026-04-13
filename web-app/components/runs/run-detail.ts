import type {
  RunDetail as RunDetailType,
  RunFile,
  RunReportEntry,
} from "@/lib/api/instrument-runs";

import { RunAnalysisSection } from "./run-analysis-section";
import { RunFilesSection } from "./run-files-section";
import { RunHeader } from "./run-header";
import { RunMetadata } from "./run-metadata";
import { RunReportSection } from "./run-report-section";

export const RunDetail = {
  Header: RunHeader,
  Metadata: RunMetadata,
  Files: RunFilesSection,
  Report: RunReportSection,
  Analysis: RunAnalysisSection,
};

export type RunDetailProps = {
  run: RunDetailType;
  files: RunFile[];
  reportData: RunReportEntry[];
  instrumentId: string;
  runId: string;
};
