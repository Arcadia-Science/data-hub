import type { ReportItemKind, ReportItemsPage } from "@/lib/runs/report-items";

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
  fetchTable(args: { fileId: number; offset: number; limit: number }): Promise<{
    columns: string[];
    rows: Record<string, string>[];
    total: number;
  }>;
  fetchArtifact(args: { suffix: string }): Promise<unknown>;
  resolveFileUrl(fileId: number): Promise<string> | string;
}
