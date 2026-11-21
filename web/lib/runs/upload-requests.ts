// Client-side calls that request uploads of a run's files, shared by the files
// table and the run page's "couldn't upload" banner so both send the same
// requests. Deleting files has its own calls in `run-file-requests.ts`.
// Client-safe: plain `fetch`, no server imports.

// The most file IDs one POST .../request-upload takes. The route refuses more
// (`requestRunUploads`), so larger requests go in batches of this size.
export const MAX_UPLOAD_FILE_IDS = 100;

export type RequestUploadsResult =
  | { ok: true }
  | { ok: false; message: string };

// Requests upload of `fileIds`, in batches of `MAX_UPLOAD_FILE_IDS`. Stops at
// the first refusal and returns its message; earlier batches stay requested.
export async function requestFileUploads(
  instrumentId: string,
  runId: string,
  fileIds: readonly number[]
): Promise<RequestUploadsResult> {
  for (let start = 0; start < fileIds.length; start += MAX_UPLOAD_FILE_IDS) {
    const batch = fileIds.slice(start, start + MAX_UPLOAD_FILE_IDS);
    const res = await fetch(
      `/api/v1/instruments/${instrumentId}/runs/${encodeURIComponent(runId)}/request-upload`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_ids: batch }),
      }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      return {
        ok: false,
        message: body?.error?.message ?? "Failed to request uploads",
      };
    }
  }
  return { ok: true };
}
