"use client";

import { useEffect } from "react";
import { useRecentNotebooks } from "@/hooks/use-recent-notebooks";

/**
 * Adds the notebook to the sidebar's recently viewed notebooks. A deleted
 * notebook is taken off the list instead, so the sidebar doesn't keep
 * offering it.
 */
export function RecordNotebookVisit({
  deleted,
  name,
  notebookId,
}: {
  deleted: boolean;
  name: string;
  notebookId: string;
}) {
  const { recordVisit, forget } = useRecentNotebooks();

  useEffect(() => {
    if (deleted) {
      forget(notebookId);
    } else {
      recordVisit({ notebookId, name, visitedAt: Date.now() });
    }
  }, [deleted, forget, name, notebookId, recordVisit]);

  return null;
}
