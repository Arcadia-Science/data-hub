import { parse } from "csv-parse/browser/esm/sync";
import { type ReportItemsPage, reportItemsUrl } from "@/lib/runs/report-items";
import type { ReportDataSource } from "@/lib/runs/view-data-source";

function restFileUrl(fileId: number): string {
  return `/api/v1/files/${fileId}/download`;
}

// Browser-side source for the Next.js run page. Closures hold the natural-key
// route ids; `fetchArtifact` is unused here because plate JSON is loaded on
// the server and passed in as props.
export function createRestReportDataSource(args: {
  instrumentId: string;
  runId: string;
}): ReportDataSource {
  const tableCache = new Map<
    number,
    { columns: string[]; rows: Record<string, string>[] }
  >();

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

    async fetchTable({ fileId, offset, limit }) {
      let parsed = tableCache.get(fileId);
      if (!parsed) {
        // Same 302-to-S3 download the viewers used to issue themselves, so
        // the web app still makes one GET per file and then slices in memory.
        const res = await fetch(restFileUrl(fileId));
        if (!res.ok) {
          throw new Error(`Failed to load table (HTTP ${res.status})`);
        }
        const rows = parse(await res.text(), {
          columns: true,
          skip_empty_lines: true,
          trim: true,
        }) as Record<string, string>[];
        parsed = {
          columns: rows.length === 0 ? [] : Object.keys(rows[0]),
          rows,
        };
        tableCache.set(fileId, parsed);
      }
      return {
        columns: parsed.columns,
        rows: parsed.rows.slice(offset, offset + limit),
        total: parsed.rows.length,
      };
    },

    fetchArtifact() {
      return Promise.reject(
        new Error(
          "fetchArtifact is not available over REST; the web app loads artifacts on the server"
        )
      );
    },

    resolveFileUrl: restFileUrl,
  };
}
