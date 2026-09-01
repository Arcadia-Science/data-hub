import { parse } from "csv-parse/browser/esm/sync";
import { type ReportItemsPage, reportItemsUrl } from "@/lib/runs/report-items";
import type {
  ReportDataSource,
  ReportTableRows,
} from "@/lib/runs/view-data-source";

function restFileUrl(fileId: number): string {
  return `/api/v1/files/${fileId}/download?disposition=inline`;
}

// Browser-side source for the Next.js run page. `resolveFileBySuffix` is left
// out because the server resolves artifacts and passes them in as props.
export function createRestReportDataSource(args: {
  instrumentId: string;
  runId: string;
}): ReportDataSource {
  const tableCache = new Map<number, ReportTableRows>();

  return {
    async fetchReportItems({ kind, offset, limit, search, anchor, signal }) {
      const response = await fetch(
        reportItemsUrl(args.instrumentId, args.runId, {
          kind,
          offset,
          limit,
          search: search ?? "",
          anchor,
        }),
        { signal }
      );
      if (!response.ok) {
        throw new Error(`Failed to load report items (${response.status})`);
      }
      return (await response.json()) as ReportItemsPage;
    },

    async fetchTableRows(fileId) {
      const cached = tableCache.get(fileId);
      if (cached) {
        return cached;
      }
      // This endpoint redirects to a presigned S3 URL, so the CSV bytes go
      // straight from S3 to the browser and skip Vercel's transfer bill.
      const res = await fetch(restFileUrl(fileId));
      if (!res.ok) {
        throw new Error(`Failed to load table (HTTP ${res.status})`);
      }
      const rows = parse(await res.text(), {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }) as Record<string, string>[];
      const parsed: ReportTableRows = {
        columns: rows.length === 0 ? [] : Object.keys(rows[0]),
        rows,
      };
      tableCache.set(fileId, parsed);
      return parsed;
    },

    peekFileUrl: restFileUrl,
    resolveFileUrl: restFileUrl,
  };
}
