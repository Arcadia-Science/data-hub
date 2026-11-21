import type { LinkedFileRelation } from "@/lib/runs/file-links";

// The words of the delete and restore dialogs and of the messages after them.
// Pure, so the counts and the wording are tested without a browser.

export type FileActionVerb = "delete" | "restore";

const PAST: Record<FileActionVerb, string> = {
  delete: "Deleted",
  restore: "Restored",
};

function filesPhrase(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

export interface FileActionMessage {
  kind: "error" | "success" | "warning";
  text: string;
}

/**
 * What to tell the person once a delete or a restore of several files is done:
 * one message when every file went through, one that counts both when some
 * failed, and one when all failed. The same three as the bulk Reprocess.
 */
export function fileActionMessage(
  verb: FileActionVerb,
  tally: { done: number; failed: number }
): FileActionMessage {
  if (tally.failed === 0) {
    return {
      kind: "success",
      text: `${PAST[verb]} ${filesPhrase(tally.done)}`,
    };
  }
  if (tally.done === 0) {
    return {
      kind: "error",
      text: `Failed to ${verb} ${filesPhrase(tally.failed)}`,
    };
  }
  return {
    kind: "warning",
    text: `${PAST[verb]} ${filesPhrase(tally.done)}, ${tally.failed} failed`,
  };
}

export interface FileActionDialogCopy {
  confirm: string;
  description: string;
  // Whether the request takes the linked files along. Only when the dialog
  // lists some and the box is checked, so the button's count is what changes.
  includeLinked: boolean;
  // The checkbox that takes the linked files along. Null when there are none.
  linkedLabel: string | null;
  title: string;
}

/**
 * The text of the delete or restore dialog, and whether its request takes the
 * linked files along. `requested` is how many files were selected, and `linked`
 * how many files the dialog lists to go along: zero while the lookup runs or
 * when it failed. The button counts the linked files while they are included,
 * so it says how many files change.
 */
export function fileActionDialogCopy(
  verb: FileActionVerb,
  counts: { includeLinked: boolean; linked: number; requested: number }
): FileActionDialogCopy {
  const word = verb === "delete" ? "Delete" : "Restore";
  const includeLinked = counts.includeLinked && counts.linked > 0;
  const total = counts.requested + (includeLinked ? counts.linked : 0);
  return {
    title:
      counts.requested === 1
        ? `${word} file?`
        : `${word} ${counts.requested} files?`,
    description:
      verb === "delete"
        ? "Deleted files are hidden from this run, from downloads, and from the API. They stay in storage, and you can restore them later."
        : "Restored files show up in this run, in downloads, and in the API again.",
    linkedLabel:
      counts.linked === 0
        ? null
        : `Also ${verb} ${counts.linked === 1 ? "1 linked file" : `${counts.linked} linked files`}`,
    confirm: `${word} ${filesPhrase(total)}`,
    includeLinked,
  };
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  if (items.length === 2) {
    return `${items[0]} and ${items[1]}`;
  }
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/**
 * The one line under "Also delete N linked files" that says what they are: the
 * videos and preview images made from the selected files, the raw files a
 * restored output was made from, and the run.json saved with them. It names
 * only the kinds that are in the list, and uses "this file" for one selection.
 */
export function linkedFilesHelp(
  relations: Iterable<LinkedFileRelation>,
  selected: number
): string {
  const present = new Set(relations);
  const several = selected !== 1;
  const parts: string[] = [];

  const made: string[] = [];
  if (present.has("video")) {
    made.push("videos");
  }
  if (present.has("preview_image")) {
    made.push("preview images");
  }
  if (present.has("output")) {
    made.push("other files");
  }
  if (made.length > 0) {
    parts.push(
      `the ${joinList(made)} made from ${several ? "these files" : "this file"}`
    );
  }
  if (present.has("made_from")) {
    parts.push(
      `the ${several ? "raw files these were" : "raw file this was"} made from`
    );
  }
  if (present.has("sidecar")) {
    parts.push(`the run.json saved with ${several ? "one of them" : "it"}`);
  }
  if (parts.length === 0) {
    return "";
  }
  // Two parts read "A, and B" as the design has it, so the comma stays.
  const sentence =
    parts.length === 2 ? `${parts[0]}, and ${parts[1]}` : joinList(parts);
  return `${sentence[0].toUpperCase()}${sentence.slice(1)}.`;
}
