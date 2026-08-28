import type { ReportDataSource } from "@/lib/runs/view-data-source";

// Must stay at or below `REPORT_VIEW_TABLE_MAX_LIMIT`; the MCP tool rejects larger pages.
const DEFAULT_TABLE_PAGE = 200;

// Raman, Aunty curves, and the colony table all need every row. `fetchTable`
// is paginated for the View's MCP envelope, so callers that chart or index
// the full file walk pages here.
export async function fetchAllTableRows(
  dataSource: ReportDataSource,
  fileId: number,
  pageSize = DEFAULT_TABLE_PAGE
): Promise<{ columns: string[]; rows: Record<string, string>[] }> {
  const first = await dataSource.fetchTable({
    fileId,
    offset: 0,
    limit: pageSize,
  });
  if (first.rows.length >= first.total) {
    return { columns: first.columns, rows: first.rows };
  }
  const rows = first.rows.slice();
  while (rows.length < first.total) {
    const page = await dataSource.fetchTable({
      fileId,
      offset: rows.length,
      limit: pageSize,
    });
    if (page.rows.length === 0) {
      break;
    }
    rows.push(...page.rows);
  }
  return { columns: first.columns, rows };
}
