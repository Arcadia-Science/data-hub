import { useCallback, useState, useTransition } from "react";

export type TrackFiles = (fileIds: number[], work: () => Promise<void>) => void;

const NO_FILES: ReadonlySet<number> = new Set();

/**
 * Runs file actions in a transition and remembers which files each one covers,
 * so only those rows show a spinner and lock their buttons. `isPending` is
 * true while any action runs, for controls that act on the whole table.
 */
export function usePendingFiles() {
  const [isPending, startTransition] = useTransition();
  const [fileIds, setFileIds] = useState<ReadonlySet<number>>(NO_FILES);

  // The transition covers the request and the refresh that follows it. Once it
  // ends, no file is pending, so drop the ids.
  if (!isPending && fileIds.size > 0) {
    setFileIds(NO_FILES);
  }

  const track = useCallback<TrackFiles>((ids, work) => {
    setFileIds((prev) => new Set([...prev, ...ids]));
    startTransition(work);
  }, []);

  const isFilePending = useCallback(
    (id: number) => isPending && fileIds.has(id),
    [isPending, fileIds]
  );

  return { isFilePending, isPending, track };
}
