// The report viewers remember which file was open so an embedded view can
// reopen on it. The web app writes the value and the MCP view reads it, so both
// share this format.
const FORMAT_VERSION = 1;

export function serializePersistedFileId(fileId: number): string {
  return JSON.stringify({ v: FORMAT_VERSION, fileId });
}

/**
 * The saved file id, or `undefined` when there is none or it was saved in a
 * format this code does not know. A value saved before versions existed has no
 * `v` and is still read.
 */
export function parsePersistedFileId(raw: string | null): number | undefined {
  if (!raw) {
    return;
  }
  try {
    const parsed = JSON.parse(raw) as { fileId?: unknown; v?: unknown };
    if (parsed.v !== undefined && parsed.v !== FORMAT_VERSION) {
      return;
    }
    return typeof parsed.fileId === "number" ? parsed.fileId : undefined;
  } catch {
    return;
  }
}
