interface InitialExpandedInput {
  /** Every entry ID, newest first. */
  ids: readonly string[];
  /** The entry a link named, if the link named one that exists. */
  linkedId: string | null;
  /** Entries that carry a New badge. */
  unseenIds: ReadonlySet<string>;
}

/**
 * Which entries start open when the changelog window opens. A link opens only
 * the entry it names. Otherwise the new entries open, except when every entry
 * is new, as on a first visit, where opening them all would undo the
 * accordion. Then, and when nothing is new, only the newest entry opens.
 */
export function initialExpandedIds({
  ids,
  linkedId,
  unseenIds,
}: InitialExpandedInput): string[] {
  if (linkedId !== null && ids.includes(linkedId)) {
    return [linkedId];
  }

  const unseen = ids.filter((id) => unseenIds.has(id));
  if (unseen.length > 0 && unseen.length < ids.length) {
    return unseen;
  }

  const newest = ids[0];
  return newest === undefined ? [] : [newest];
}
