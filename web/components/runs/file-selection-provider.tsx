"use client";

import { createContext, use, useCallback, useMemo, useState } from "react";
import type { RunFile } from "@/lib/api/instrument-runs";
import { REPROCESSABLE_STATUSES } from "@/lib/runs/reprocessable-statuses";

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

const REPROCESSABLE_STATUS_SET = new Set<string>(REPROCESSABLE_STATUSES);

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
export function buildFileRef(file: RunFile): FileRef | null {
  if (file.deletedAt !== null) {
    return null;
  }
  const isDetected = file.status === "detected";
  const canDownload = DOWNLOADABLE_STATUSES.has(file.status);
  const canReprocess =
    REPROCESSABLE_STATUS_SET.has(file.status) && file.s3Key !== null;
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
}: {
  children: React.ReactNode;
}) {
  const [selected, setSelected] = useState<Map<number, FileRef>>(
    () => new Map()
  );

  const toggle = useCallback((ref: FileRef) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(ref.id)) {
        next.delete(ref.id);
      } else {
        next.set(ref.id, ref);
      }
      return next;
    });
  }, []);

  // Toggle a page's worth of refs as a unit — if every ref is already
  // selected we deselect them, otherwise we add the missing ones. Matches
  // RunSelectionProvider so the select-all checkbox behaves identically.
  const selectMany = useCallback((refs: FileRef[]) => {
    setSelected((prev) => {
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
  }, []);

  const clear = useCallback(() => {
    setSelected(new Map());
  }, []);

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
