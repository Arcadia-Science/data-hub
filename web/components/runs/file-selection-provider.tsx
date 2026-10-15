"use client";

import { useSearchParams } from "next/navigation";
import { createContext, use, useCallback, useMemo, useState } from "react";
import type { RunFileRow } from "@/lib/api/instrument-runs";
import type { InstrumentType } from "@/lib/db/schema";
import { canReprocessFile } from "@/lib/runs/reprocessable-statuses";
import { isFilesScopeParam, selectionScopeKey } from "@/lib/selection-scope";

// ---------------------------------------------------------------------------
// File selection provider for the run files table. Mirrors RunSelectionProvider
// in shape (state / actions / meta) so the bulk action bar can derive a
// rollup from per-row capabilities and only surface actions every selected
// file supports — pending and uploaded files share a selection but their
// action sets are disjoint, so a mixed selection collapses to "Clear" only.
// ---------------------------------------------------------------------------

const DOWNLOADABLE_STATUSES = new Set([
  "uploaded",
  "processing",
  "completed",
  "failed",
]);

export interface FileCaps {
  dismiss: boolean;
  download: boolean;
  reprocess: boolean;
  upload: boolean;
}

export interface FileRef {
  caps: FileCaps;
  filename: string;
  id: number;
}

// Returns null for rows that should not participate in selection at all
// (dismissed files, transient `upload_requested` rows). Caller treats null
// the same as "no checkbox in this row".
export function buildFileRef(
  file: RunFileRow,
  instrumentType: InstrumentType
): FileRef | null {
  if (file.deletedAt !== null) {
    return null;
  }
  const isDetected = file.status === "detected";
  const canDownload = DOWNLOADABLE_STATUSES.has(file.status);
  const canReprocess = canReprocessFile(file, instrumentType);
  if (!(isDetected || canDownload)) {
    return null;
  }
  return {
    id: file.id,
    filename: file.filename,
    caps: {
      upload: isDetected,
      dismiss: isDetected,
      reprocess: canReprocess,
      download: canDownload,
    },
  };
}

// Files on the current page take their actions from the live row. A file whose
// status moved on (it finished uploading, or was dismissed elsewhere) gets new
// actions or drops out of the selection. Files picked on other pages keep the
// actions they had when picked, because their rows are not loaded.
export function refreshFileRefs(
  picked: ReadonlyMap<number, FileRef>,
  files: RunFileRow[],
  instrumentType: InstrumentType
): Map<number, FileRef> {
  const live = new Map(files.map((f) => [f.id, f]));
  const next = new Map<number, FileRef>();
  for (const [id, ref] of picked) {
    const row = live.get(id);
    if (row === undefined) {
      next.set(id, ref);
      continue;
    }
    const current = buildFileRef(row, instrumentType);
    if (current !== null) {
      next.set(id, current);
    }
  }
  return next;
}

interface FileSelectionContextValue {
  actions: {
    toggle: (ref: FileRef) => void;
    selectMany: (refs: FileRef[]) => void;
    clear: () => void;
  };
  meta: {
    count: number;
    isSelected: (id: number) => boolean;
    allSelected: (refs: FileRef[]) => boolean;
    someSelected: (refs: FileRef[]) => boolean;
    allCanUpload: boolean;
    allCanDismiss: boolean;
    allCanReprocess: boolean;
    allCanDownload: boolean;
  };
  state: { selected: ReadonlyMap<number, FileRef> };
}

const FileSelectionContext = createContext<FileSelectionContextValue | null>(
  null
);

export function FileSelectionProvider({
  children,
  files,
  instrumentType,
}: {
  children: React.ReactNode;
  // The rows on screen now. They refresh every few seconds while files are in
  // flight, and the actions a selected file allows follow its current status.
  files: RunFileRow[];
  instrumentType: InstrumentType;
}) {
  const searchParams = useSearchParams();
  const scopeKey = selectionScopeKey(searchParams, isFilesScopeParam);
  const [store, setStore] = useState(() => ({
    scopeKey,
    picked: new Map<number, FileRef>(),
  }));

  // A new search, filter, or sort lists different files, so picks made on the
  // old list could be off screen. Clear them so Dismiss and Reprocess never
  // reach files the user can no longer see. Another page of the same results
  // keeps the selection.
  if (store.scopeKey !== scopeKey) {
    setStore({ scopeKey, picked: new Map() });
  }

  const selected = useMemo(
    () => refreshFileRefs(store.picked, files, instrumentType),
    [store.picked, files, instrumentType]
  );

  const setPicked = useCallback(
    (update: (prev: Map<number, FileRef>) => Map<number, FileRef>) => {
      setStore((prev) => ({ ...prev, picked: update(prev.picked) }));
    },
    []
  );

  const toggle = useCallback(
    (ref: FileRef) => {
      setPicked((prev) => {
        const next = new Map(prev);
        if (next.has(ref.id)) {
          next.delete(ref.id);
        } else {
          next.set(ref.id, ref);
        }
        return next;
      });
    },
    [setPicked]
  );

  // Toggle a page's worth of refs as a unit — if every ref is already
  // selected we deselect them, otherwise we add the missing ones. Matches
  // RunSelectionProvider so the select-all checkbox behaves identically.
  const selectMany = useCallback(
    (refs: FileRef[]) => {
      setPicked((prev) => {
        const next = new Map(prev);
        const alreadyAll = refs.length > 0 && refs.every((r) => next.has(r.id));
        if (alreadyAll) {
          for (const r of refs) {
            next.delete(r.id);
          }
        } else {
          for (const r of refs) {
            next.set(r.id, r);
          }
        }
        return next;
      });
    },
    [setPicked]
  );

  const clear = useCallback(() => {
    setPicked(() => new Map());
  }, [setPicked]);

  const value = useMemo<FileSelectionContextValue>(() => {
    const refs = Array.from(selected.values());
    const count = refs.length;
    return {
      state: { selected },
      actions: { toggle, selectMany, clear },
      meta: {
        count,
        isSelected: (id) => selected.has(id),
        allSelected: (visible) =>
          visible.length > 0 && visible.every((r) => selected.has(r.id)),
        someSelected: (visible) =>
          visible.some((r) => selected.has(r.id)) &&
          !visible.every((r) => selected.has(r.id)),
        allCanUpload: count > 0 && refs.every((r) => r.caps.upload),
        allCanDismiss: count > 0 && refs.every((r) => r.caps.dismiss),
        allCanReprocess: count > 0 && refs.every((r) => r.caps.reprocess),
        allCanDownload: count > 0 && refs.every((r) => r.caps.download),
      },
    };
  }, [selected, toggle, selectMany, clear]);

  return (
    <FileSelectionContext.Provider value={value}>
      {children}
    </FileSelectionContext.Provider>
  );
}

export function useFileSelection(): FileSelectionContextValue {
  const ctx = use(FileSelectionContext);
  if (!ctx) {
    throw new Error(
      "useFileSelection must be used within a FileSelectionProvider"
    );
  }
  return ctx;
}
