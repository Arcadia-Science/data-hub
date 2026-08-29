import type { ReportItemKind, ReportItemsPage } from "@/lib/runs/report-items";

export interface ReportTablePage {
  columns: string[];
  rows: Record<string, string>[];
  total: number;
  truncated?: boolean;
}

// Contract shared by the Next.js run page (REST) and the MCP Apps View.
// The View agent implements the MCP-backed side against this exact shape.
// biome-ignore assist/source/useSortedInterfaceMembers: keep the published method order
export interface ReportDataSource {
  fetchReportItems(args: {
    kind: ReportItemKind;
    offset: number;
    limit: number;
    search?: string;
    anchor?: number;
  }): Promise<ReportItemsPage>;
  fetchTable(args: {
    fileId: number;
    offset: number;
    limit: number;
  }): Promise<ReportTablePage>;
  fetchArtifact(args: { suffix: string }): Promise<unknown>;
  resolveFileUrl(fileId: number): Promise<string> | string;
  // Synchronous cache/path lookup for render. The MCP source is async, so
  // calling `resolveFileUrl` during render would allocate a Promise every
  // time. REST implements this as the download path.
  peekFileUrl?(fileId: number): string | null;
}
