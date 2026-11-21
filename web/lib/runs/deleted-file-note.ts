import { actorDisplayName } from "@/lib/api/actor";
import type { RunFileRow } from "@/lib/api/instrument-runs";
import { formatDate, formatTime } from "@/lib/date";

// What a deleted file says about its deletion, in the status tooltip and in the
// file window's banner. A person's name or a token's name says who, and a file
// deleted before Data Hub recorded who did it has no one to name.

type DeletedFile = Pick<RunFileRow, "deleter"> & { deletedAt: Date };

function dateAndTime(date: Date, timeZone: string): string {
  return `${formatDate(date, timeZone)} at ${formatTime(date, timeZone)}`;
}

/** "Deleted by Ada Lovelace on Nov 19, 2026 at 10:42 AM", or "Deleted on Nov 19, 2026". */
export function deletedTooltip(file: DeletedFile, timeZone: string): string {
  return file.deleter
    ? `Deleted by ${actorDisplayName(file.deleter)} on ${dateAndTime(file.deletedAt, timeZone)}`
    : `Deleted on ${formatDate(file.deletedAt, timeZone)}`;
}

/**
 * The sentence at the top of the file window for a deleted file: "Ada Lovelace
 * deleted this file on Nov 19, 2026 at 10:42 AM.", or "This file was deleted on
 * Nov 19, 2026." when nobody was recorded.
 */
export function deletedBanner(file: DeletedFile, timeZone: string): string {
  return file.deleter
    ? `${actorDisplayName(file.deleter)} deleted this file on ${dateAndTime(file.deletedAt, timeZone)}.`
    : `This file was deleted on ${formatDate(file.deletedAt, timeZone)}.`;
}
