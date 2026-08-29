import type { Readable } from "node:stream";
import { parse } from "csv-parse";
import { REPORT_VIEW_TABLE_SCAN_CAP } from "@/lib/mcp/ui-apps";
import { getS3ObjectStream } from "@/lib/s3";

export interface ParsedCsvPage {
  columns: string[];
  rows: Record<string, string>[];
  total: number;
  truncated: boolean;
}

export async function parseCsvPageFromStream(
  stream: Readable,
  offset: number,
  limit: number,
  scanCap = REPORT_VIEW_TABLE_SCAN_CAP
): Promise<ParsedCsvPage> {
  const parser = stream.pipe(
    parse({ columns: true, skip_empty_lines: true, trim: true })
  );

  let index = 0;
  const rows: Record<string, string>[] = [];
  let columns: string[] = [];
  let truncated = false;

  try {
    for await (const record of parser) {
      const row = record as Record<string, string>;
      if (index === 0) {
        columns = Object.keys(row);
      }
      if (index >= offset && rows.length < limit) {
        rows.push(row);
      }
      index += 1;
      if (index >= scanCap) {
        truncated = true;
        break;
      }
    }
  } finally {
    parser.destroy();
    stream.destroy();
  }

  return { columns, rows, total: index, truncated };
}

export async function parseCsvPage(
  bucket: string,
  key: string,
  offset: number,
  limit: number,
  scanCap = REPORT_VIEW_TABLE_SCAN_CAP
): Promise<ParsedCsvPage> {
  const stream = await getS3ObjectStream(bucket, key);
  return parseCsvPageFromStream(stream, offset, limit, scanCap);
}
