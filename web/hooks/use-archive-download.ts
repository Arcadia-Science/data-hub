"use client";

import {
  ArchiveDownloadContext,
  type ArchiveDownloadActions,
  type ArchiveDownloadJob,
} from "@/components/runs/archive-download-provider";
import { use } from "react";

// Hook for triggering archive downloads. Cache hits are silent (browser
// downloads immediately); cache misses go async and surface in a status
// dialog rendered by `ArchiveDownloadProvider`. Components are expected to
// be rendered under the provider; calling outside of it throws to fail
// loud rather than silently dropping clicks.
export function useArchiveDownload(): {
  jobs: ArchiveDownloadJob[];
  actions: ArchiveDownloadActions;
} {
  const ctx = use(ArchiveDownloadContext);
  if (!ctx) {
    throw new Error(
      "useArchiveDownload must be used inside an <ArchiveDownloadProvider>"
    );
  }
  return ctx;
}
