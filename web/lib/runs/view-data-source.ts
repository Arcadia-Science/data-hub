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

// Shared by the Next.js run page (REST) and the MCP Apps View. Both read file
// bytes straight from S3 and parse them in the browser, never via the server.
// biome-ignore assist/source/useSortedInterfaceMembers: keep the published method order
export interface ReportDataSource {
  // `signal` is optional so an implementation may ignore it; callers must
  // still discard a resolved page they no longer want.
  fetchReportItems(args: {
    kind: ReportItemKind;
    offset: number;
    limit: number;
    search?: string;
    anchor?: number;
    signal?: AbortSignal;
  }): Promise<ReportItemsPage>;
  // Whole file, parsed. Callers read every row and both sources cache per
  // file id, so paging would buy nothing.
  fetchTableRows(fileId: number): Promise<ReportTableRows>;
  resolveFileUrl(fileId: number): Promise<string> | string;
  // Safe to call during render, unlike the async `resolveFileUrl`.
  peekFileUrl?(fileId: number): string | null;
  // View only. The web app resolves artifacts on the server instead.
  resolveFileBySuffix?(suffix: string): Promise<ReportFileRef>;
}
