// Copy helpers for grouped `run_created` rows. Byte size is intentionally
// omitted — the bell redesign dropped per-run size so the detail line stays
// to file count + time of day.

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function formatRunFileLine(
  fileCount: number,
  filesFailed: number
): string {
  if (fileCount <= 0) {
    return "No files";
  }
  if (filesFailed > 0) {
    const ok = Math.max(0, fileCount - filesFailed);
    return `${ok} of ${pluralize(fileCount, "file")}`;
  }
  return pluralize(fileCount, "file");
}

export function formatRunFailureLine(
  fileCount: number,
  filesFailed: number
): string {
  return `${filesFailed} of ${pluralize(fileCount, "file")} failed to upload`;
}

export function formatRunGroupSummary(
  runCount: number,
  unreadCount: number
): string {
  const noun = runCount === 1 ? "run" : "runs";
  if (unreadCount > 0) {
    const unreadNoun = unreadCount === 1 ? "run" : "runs";
    return unreadCount === runCount
      ? `${runCount} new ${noun}`
      : `${unreadCount} new ${unreadNoun}`;
  }
  return `${runCount} ${noun}`;
}
