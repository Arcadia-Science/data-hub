import type { ReportItemKind, ReportItemsPage } from "@/lib/runs/report-items";

export interface ReportTableRows {
  columns: string[];
  rows: Record<string, string>[];
}

export interface ReportFileRef {
  filename: string;
  id: number;
  url: string;
}

// Contract shared by the Next.js run page (REST) and the MCP Apps View.
// Both fetch file bytes straight from S3 and parse them in the browser, so
// neither one streams a CSV or a JSON artifact through the server.
// biome-ignore assist/source/useSortedInterfaceMembers: keep the published method order
export interface ReportDataSource {
  fetchReportItems(args: {
    kind: ReportItemKind;
    offset: number;
    limit: number;
    search?: string;
    anchor?: number;
  }): Promise<ReportItemsPage>;
  // Whole file, parsed. Callers chart or index every row, and both sources
  // cache per file id, so there is nothing to gain from paging here.
  fetchTableRows(fileId: number): Promise<ReportTableRows>;
  resolveFileUrl(fileId: number): Promise<string> | string;
  // Synchronous cache/path lookup for render. The MCP source is async, so
  // calling `resolveFileUrl` during render would allocate a Promise every
  // time. REST implements this as the download path.
  peekFileUrl?(fileId: number): string | null;
  // Find one file on the run by filename suffix. Only the View implements
  // this; the web app resolves artifacts on the server and passes them in.
  resolveFileBySuffix?(suffix: string): Promise<ReportFileRef>;
}
