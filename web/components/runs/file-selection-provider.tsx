"use client";

import { useSearchParams } from "next/navigation";
import { createContext, use, useCallback, useMemo, useState } from "react";
import { SelectionNotice } from "@/components/selection-notice";
import type { RunFileRow } from "@/lib/api/instrument-runs";
import type { InstrumentType } from "@/lib/db/schema";
import { canDeleteFile } from "@/lib/runs/deletable-files";
import {
  type FileBarState,
  type FileCaps,
  fileBarState,
} from "@/lib/runs/file-bar-actions";
import {
  IN_S3_FILE_STATUSES,
  isRequestableFileStatus,
} from "@/lib/runs/file-buckets";
import { canReprocessFile } from "@/lib/runs/reprocessable-statuses";
import { isFilesScopeParam, selectionScopeKey } from "@/lib/selection-scope";

// ---------------------------------------------------------------------------
// File selection provider for the run files table. Mirrors RunSelectionProvider
// in shape (state / actions / meta) so the bulk action bar can derive a
// rollup from per-row capabilities and only surface actions every selected
// file supports. A selection of pending and uploaded files can still be
// deleted, since both can, but it offers nothing else, and a selection that
// mixes deleted files with active ones shares no action, so it collapses to
// "Clear" only.
// ---------------------------------------------------------------------------

const DOWNLOADABLE_STATUSES = new Set<string>(IN_S3_FILE_STATUSES);

export interface FileRef {
  caps: FileCaps;
  // The file is deleted. It can only be restored.
  deleted: boolean;
  filename: string;
  id: number;
  relativePath: string | null;
  sizeBytes: number | null;
}

// Every row can be selected. A deleted file offers Restore and nothing else,
// including download: a selection of deleted files is for bringing them back.
// Each row reads the actions it supports from its own state.
export function buildFileRef(
  file: RunFileRow,
  instrumentType: InstrumentType
): FileRef {
  const base = {
    id: file.id,
    filename: file.filename,
    relativePath: file.relativePath,
    sizeBytes: file.sizeBytes,
  };
  if (file.deletedAt !== null) {
    return {
      ...base,
      deleted: true,
      caps: {
        upload: false,
        download: false,
        reprocess: false,
        delete: false,
        restore: true,
      },
    };
  }
  return {
    ...base,
    deleted: false,
    caps: {
      // `detected` and `upload_failed` files are on the PC and can be requested.
      upload: isRequestableFileStatus(file.status),
      download: DOWNLOADABLE_STATUSES.has(file.status),
      reprocess: canReprocessFile(file, instrumentType),
      delete: canDeleteFile(file),
      restore: false,
    },
  };
}

// A selected file and the page of results it was picked on.
export interface PickedFile {
  page: number;
  ref: FileRef;
}

// Files on the current page take their actions from the live row. A file whose
// status moved on gets new actions, and one that was deleted or restored
// elsewhere changes between Delete and Restore. A file picked on this page
// whose row is gone has left the results (it finished uploading under a
// "Pending" filter, or was deleted elsewhere while deleted files are hidden),
// so it drops out. Files picked on other pages keep the actions they had when
// picked, because their rows are not loaded.
export function refreshFileRefs(
  picked: ReadonlyMap<number, PickedFile>,
  files: RunFileRow[],
  instrumentType: InstrumentType,
  currentPage: number
): Map<number, PickedFile> {
  const live = new Map(files.map((f) => [f.id, f]));
  const next = new Map<number, PickedFile>();
  for (const [id, pick] of picked) {
    const row = live.get(id);
    if (row === undefined) {
      if (pick.page !== currentPage) {
        next.set(id, pick);
      }
      continue;
    }
    next.set(id, { page: currentPage, ref: buildFileRef(row, instrumentType) });
  }
  return next;
}

// The files table's current page, from `files_page`. Anything unreadable is
// page 1, the table's default.
function filesPageOf(searchParams: URLSearchParams): number {
  const page = Number.parseInt(searchParams.get("files_page") ?? "", 10);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

const SELECTION_CLEARED_NOTICE =
  "Selection cleared because the list of files changed.";

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
    // The actions the bar offers, and what it calls the selected files.
    bar: FileBarState;
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
  const currentPage = filesPageOf(searchParams);
  const [store, setStore] = useState(() => ({
    scopeKey,
    picked: new Map<number, PickedFile>(),
    notice: "",
  }));

  // A new search, filter, or sort lists different files, so picks made on the old
  // list could be off screen. Dropping them keeps Delete and Reprocess away from
  // files the user is not looking at. Another page of the same results keeps them.
  if (store.scopeKey !== scopeKey) {
    setStore({
      scopeKey,
      picked: new Map(),
      notice: store.picked.size > 0 ? SELECTION_CLEARED_NOTICE : "",
    });
  }

  const refreshed = useMemo(
    () => refreshFileRefs(store.picked, files, instrumentType, currentPage),
    [store.picked, files, instrumentType, currentPage]
  );

  // Picks that left this page's results are removed from the stored state too,
  // so a file cannot come back selected if it later returns to the list.
  if (store.scopeKey === scopeKey && refreshed.size < store.picked.size) {
    const dropped = store.picked.size - refreshed.size;
    setStore({
      scopeKey,
      picked: refreshed,
      notice: `${dropped} selected ${dropped === 1 ? "file" : "files"} changed and ${dropped === 1 ? "was" : "were"} deselected.`,
    });
  }

  const selected = useMemo(
    () => new Map([...refreshed].map(([id, pick]) => [id, pick.ref])),
    [refreshed]
  );

  const setPicked = useCallback(
    (update: (prev: Map<number, PickedFile>) => Map<number, PickedFile>) => {
      setStore((prev) => ({
        ...prev,
        picked: update(prev.picked),
        notice: "",
      }));
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
          next.set(ref.id, { page: currentPage, ref });
        }
        return next;
      });
    },
    [setPicked, currentPage]
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
            next.set(r.id, { page: currentPage, ref: r });
          }
        }
        return next;
      });
    },
    [setPicked, currentPage]
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
        bar: fileBarState(refs),
      },
    };
  }, [selected, toggle, selectMany, clear]);

  return (
    <FileSelectionContext.Provider value={value}>
      {children}
      <SelectionNotice message={store.notice} />
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
