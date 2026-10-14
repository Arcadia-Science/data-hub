import { parse } from "csv-parse/browser/esm/sync";
import type { FilePreviewKind } from "@/lib/runs/run-file-types";

export const PREVIEW_BYTE_LIMIT = 1024 * 1024;

export type FilePreviewRow = Record<string, string>;

export type FilePreviewContent =
  | { kind: "table"; rows: FilePreviewRow[] }
  | { kind: "text"; pretty?: boolean; text: string };

export interface FilePreview {
  content: FilePreviewContent;
  truncated: boolean;
}

// Asks for one byte more than the limit. S3 does not expose `Content-Range` to
// the browser, so getting more than the limit back is how we know the file is
// bigger. A server that ignores `Range` and sends everything still works.
export async function fetchFilePreviewBytes(
  fileId: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const res = await fetch(
    `/api/v1/files/${fileId}/download?disposition=inline`,
    {
      headers: { Range: `bytes=0-${PREVIEW_BYTE_LIMIT}` },
      signal,
    }
  );
  // S3 and the local mirror answer a range request on a zero-byte file with
  // 416, since no byte range of it exists.
  if (res.status === 416) {
    return new Uint8Array(0);
  }
  if (!res.ok) {
    throw new Error(`Failed to load file (HTTP ${res.status})`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

export function capPreviewBytes(bytes: Uint8Array): {
  bytes: Uint8Array;
  truncated: boolean;
} {
  if (bytes.length <= PREVIEW_BYTE_LIMIT) {
    return { bytes, truncated: false };
  }
  return { bytes: bytes.subarray(0, PREVIEW_BYTE_LIMIT), truncated: true };
}

export function decodePreviewText(
  bytes: Uint8Array,
  truncated: boolean
): string {
  const text = new TextDecoder("utf-8").decode(bytes);
  // A character split by the cut decodes to U+FFFD at the very end.
  return truncated && text.endsWith("\uFFFD") ? text.slice(0, -1) : text;
}

export function dropPartialLastRow(text: string): string {
  const lastNewline = text.lastIndexOf("\n");
  return lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
}

export function buildFilePreview(
  kind: FilePreviewKind,
  text: string,
  truncated: boolean
): FilePreview {
  return { content: buildContent(kind, text, truncated), truncated };
}

function buildContent(
  kind: FilePreviewKind,
  text: string,
  truncated: boolean
): FilePreviewContent {
  if (kind === "csv" || kind === "tsv") {
    const source = truncated ? dropPartialLastRow(text) : text;
    try {
      const rows = parse(source, {
        columns: true,
        delimiter: kind === "tsv" ? "\t" : ",",
        skip_empty_lines: true,
        trim: true,
      }) as FilePreviewRow[];
      // A cut-off file whose first part holds no whole row would otherwise
      // look empty.
      if (truncated && rows.length === 0) {
        return { kind: "text", text };
      }
      return { kind: "table", rows };
    } catch {
      return { kind: "text", text };
    }
  }
  // A cut-off JSON file can never parse, so show it as it is.
  if (kind === "json" && !truncated) {
    try {
      return {
        kind: "text",
        pretty: true,
        text: JSON.stringify(JSON.parse(text), null, 2),
      };
    } catch {
      return { kind: "text", text };
    }
  }
  return { kind: "text", text };
}

export async function loadFilePreview(
  fileId: number,
  kind: FilePreviewKind,
  signal?: AbortSignal
): Promise<FilePreview> {
  const raw = await fetchFilePreviewBytes(fileId, signal);
  const { bytes, truncated } = capPreviewBytes(raw);
  return buildFilePreview(kind, decodePreviewText(bytes, truncated), truncated);
}
