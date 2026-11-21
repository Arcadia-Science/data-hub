// What the files table's bar offers for the files that are selected.

// What each selected file supports. The bar offers an action only when every
// selected file supports it.
export interface FileCaps {
  delete: boolean;
  download: boolean;
  reprocess: boolean;
  restore: boolean;
  upload: boolean;
}

export type FileBarAction = keyof FileCaps;

// The order of the buttons, left to right. Clear always comes last, and the bar
// itself draws it.
export const FILE_BAR_ACTION_ORDER: readonly FileBarAction[] = [
  "upload",
  "download",
  "reprocess",
  "delete",
  "restore",
];

export interface FileBarState {
  actions: FileBarAction[];
  // The bar says "3 files selected", or "3 deleted files selected" when every
  // selected file is deleted.
  noun: "deleted file" | "file";
}

export function fileBarState(
  refs: readonly { caps: FileCaps; deleted: boolean }[]
): FileBarState {
  if (refs.length === 0) {
    return { actions: [], noun: "file" };
  }
  return {
    actions: FILE_BAR_ACTION_ORDER.filter((action) =>
      refs.every((ref) => ref.caps[action])
    ),
    noun: refs.every((ref) => ref.deleted) ? "deleted file" : "file",
  };
}

// Whether a select-all picks a page's active files or its deleted ones. It
// picks the active ones whenever the page has any, so a page that mixes the two
// can still be selected in one click and offered Delete. A page of only deleted
// files picks those, so they can be restored together.
export function selectAllTargets<T extends { deleted: boolean }>(
  refs: readonly T[]
): T[] {
  const active = refs.filter((ref) => !ref.deleted);
  return active.length > 0 ? active : [...refs];
}
