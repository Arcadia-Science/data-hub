import { parse } from "csv-parse/browser/esm/sync";
import { type ReportItemsPage, reportItemsUrl } from "@/lib/runs/report-items";
import type {
  ReportDataSource,
  ReportTableRows,
} from "@/lib/runs/view-data-source";

function restFileUrl(fileId: number): string {
  return `/api/v1/files/${fileId}/download`;
}

// Browser-side source for the Next.js run page. Closures hold the natural-key
// route ids; `resolveFileBySuffix` is unimplemented here because artifacts are
// loaded on the server and passed into the page as props.
export function createRestReportDataSource(args: {
  instrumentId: string;
  runId: string;
}): ReportDataSource {
  const tableCache = new Map<number, ReportTableRows>();

  return {
    async fetchReportItems({ kind, offset, limit, search, anchor }) {
      const response = await fetch(
        reportItemsUrl(args.instrumentId, args.runId, {
          kind,
          offset,
          limit,
          search: search ?? "",
          anchor,
        })
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
      // The download endpoint 302-redirects to a short-lived presigned S3
      // URL, so the CSV bytes flow straight from S3 to the browser with zero
      // Vercel Fast Origin Transfer.
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
