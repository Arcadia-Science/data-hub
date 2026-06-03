"use client";

import { PaginationNav } from "@/components/pagination-nav";
import {
  TablePendingBoundary,
  TablePendingProvider,
  useTablePending,
} from "@/components/table-pending";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useArchiveDownload } from "@/hooks/use-archive-download";
import type {
  FilesSortField,
  FilesStatusFilter,
  RunFile,
  RunFilesPage,
  RunFileStats,
} from "@/lib/api/instrument-runs";
import { runDetailSearchParams } from "@/lib/search-params";
import { Download, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useQueryStates } from "nuqs";
import { useEffect, useTransition } from "react";
import { toast } from "sonner";
import { FileBulkActionBar } from "./file-bulk-action-bar";
import {
  type FileRef,
  FileSelectionProvider,
  useFileSelection,
} from "./file-selection-provider";
import { EditableRunFilesTable, ReadOnlyRunFilesTable } from "./run-files-table";

type RunFilesSectionProps = {
  // Current page of the server-paginated, filtered, sorted file list.
  files: RunFile[];
  pagination: RunFilesPage["pagination"];
  // Aggregate per-run counts used for the footer summary, filter labels, and
  // the in-flight auto-refresh signal — independent of the current filter.
  stats: RunFileStats;
  instrumentId: string;
  runId: string;
  isDeleted: boolean;
};

// Synchronously trigger one anchor-click per file so the browser treats
// them all as the same user gesture (Chrome silently drops downloads
// scheduled via setTimeout). The `download` attribute prompts a save —
// the server's Content-Disposition still wins for the actual filename.
function fanOutFileDownload(refs: FileRef[]) {
  for (const ref of refs) {
    const a = document.createElement("a");
    a.href = `/api/v1/files/${ref.id}/download`;
    a.download = ref.filename;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

export function RunFilesSection(props: RunFilesSectionProps) {
  // TablePendingProvider wraps the whole section so the toolbar's URL updates
  // and PaginationNav share the same React transition, dimming the table
  // while the next server page streams in. The read-only path additionally
  // skips the selection provider since those runs can't be modified.
  return (
    <TablePendingProvider>
      {props.isDeleted ? (
        <RunFilesSectionContent {...props} />
      ) : (
        <FileSelectionProvider>
          <RunFilesSectionContent {...props} />
        </FileSelectionProvider>
      )}
    </TablePendingProvider>
  );
}

function RunFilesSectionContent({
  files,
  pagination,
  stats,
  instrumentId,
  runId,
  isDeleted,
}: RunFilesSectionProps) {
  const router = useRouter();
  const { actions: archiveActions } = useArchiveDownload();
  // Mutation transition (upload/dismiss/reprocess) — distinct from the table's
  // navigation transition below.
  const [isPending, startTransition] = useTransition();

  // All search / filter / sort / page state lives in the URL. `shallow:false`
  // triggers the RSC refetch, `startTransition` ties it to the table's stale
  // treatment, and `throttleMs` debounces search keystrokes. Every
  // filter/sort change also resets `files_page` to 1 so the user never lands
  // on an out-of-range page (default values drop out of the URL via nuqs
  // clearOnDefault).
  const { startTransition: tableStartTransition } = useTablePending();
  const [filters, setFilters] = useQueryStates(runDetailSearchParams, {
    shallow: false,
    throttleMs: 300,
    startTransition: tableStartTransition,
  });

  // Auto-refresh while work is genuinely in flight (uploading or processing)
  // so the UI picks up status transitions without a manual reload. Files that
  // are merely "detected" (awaiting a manual upload) don't trigger polling.
  const hasInFlight = stats.processing > 0 || stats.uploadRequested > 0;
  useEffect(() => {
    if (!hasInFlight) return;
    const id = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(id);
  }, [hasInFlight, router]);

  // The archive route resolves the active filters to a downloadable file set
  // server-side, so "Download all" honors search/status/dismissed across every
  // page (not just the rows currently on screen). With no filters active we
  // omit the params so the route's default "all downloadable files" path runs.
  const isFilterActive =
    filters.files_search.trim() !== "" ||
    filters.files_status !== "all" ||
    filters.files_dismissed;
  const archiveBaseHref = `/api/v1/instruments/${instrumentId}/runs/${encodeURIComponent(runId)}/download-archive`;
  let downloadHref = archiveBaseHref;
  if (isFilterActive) {
    const params = new URLSearchParams();
    if (filters.files_search.trim()) {
      params.set("search", filters.files_search.trim());
    }
    if (filters.files_status !== "all") {
      params.set("status", filters.files_status);
    }
    if (filters.files_dismissed) params.set("dismissed", "true");
    downloadHref = `${archiveBaseHref}?${params.toString()}`;
  }

  // Count of downloadable active files in the whole run (uploaded/processing/
  // completed/failed). `stats.uploaded` already folds completed+failed in, so
  // adding processing covers the full downloadable set.
  const downloadableCount = stats.uploaded + stats.processing;

  const from =
    pagination.total === 0
      ? 0
      : (pagination.page - 1) * pagination.per_page + 1;
  const to = Math.min(pagination.page * pagination.per_page, pagination.total);

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">Files</h2>
      <div className="rounded-lg border bg-background dark:bg-muted">
        {/* Toolbar: search, filter, sort */}
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search files..."
              value={filters.files_search}
              onChange={(e) =>
                setFilters({ files_search: e.target.value, files_page: 1 })
              }
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Select
            value={filters.files_status}
            onValueChange={(v) =>
              setFilters({
                files_status: v as FilesStatusFilter,
                files_page: 1,
              })
            }
          >
            <SelectTrigger size="sm" className="h-8 text-sm">
              <SelectValue>
                {filters.files_status === "all"
                  ? `All (${stats.active})`
                  : undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-sm">
                All ({stats.active})
              </SelectItem>
              <SelectItem value="raw" className="text-sm">
                Raw
              </SelectItem>
              <SelectItem value="processed" className="text-sm">
                Processed
              </SelectItem>
              <SelectItem value="pending" className="text-sm">
                Pending
              </SelectItem>
              <SelectItem value="uploaded" className="text-sm">
                Uploaded
              </SelectItem>
              <SelectItem value="processing" className="text-sm">
                Processing
              </SelectItem>
              <SelectItem value="completed" className="text-sm">
                Completed
              </SelectItem>
              <SelectItem value="failed" className="text-sm">
                Failed
              </SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={filters.files_sort}
            onValueChange={(v) =>
              setFilters({ files_sort: v as FilesSortField, files_page: 1 })
            }
          >
            <SelectTrigger size="sm" className="h-8 text-sm">
              <SelectValue>
                Sort:{" "}
                {filters.files_sort === "name"
                  ? "Name"
                  : filters.files_sort === "size"
                    ? "Size"
                    : filters.files_sort === "date"
                      ? "Date"
                      : "Status"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name" className="text-sm">
                Sort: Name
              </SelectItem>
              <SelectItem value="size" className="text-sm">
                Sort: Size
              </SelectItem>
              <SelectItem value="date" className="text-sm">
                Sort: Date
              </SelectItem>
              <SelectItem value="status" className="text-sm">
                Sort: Status
              </SelectItem>
            </SelectContent>
          </Select>
          {stats.dismissed > 0 && (
            <Button
              variant={filters.files_dismissed ? "secondary" : "ghost"}
              size="sm"
              className="h-8 text-sm"
              onClick={() =>
                setFilters({
                  files_dismissed: !filters.files_dismissed,
                  files_page: 1,
                })
              }
            >
              {filters.files_dismissed ? "Hide dismissed" : "Show dismissed"}
            </Button>
          )}
          {downloadableCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-sm"
              onClick={() =>
                archiveActions.start({
                  archiveUrl: downloadHref,
                  runId,
                  defaultFilename: `${runId}.zip`,
                })
              }
            >
              <Download className="size-3" />
              {isFilterActive
                ? "Download filtered"
                : `Download all (${downloadableCount})`}
            </Button>
          )}
        </div>

        {/* Bulk action bar — provider-driven, only renders when something
            is selected. Read-only runs skip the provider entirely above. */}
        {!isDeleted && (
          <BulkActionBarHost
            instrumentId={instrumentId}
            runId={runId}
            isPending={isPending}
            startTransition={startTransition}
          />
        )}

        {/* Dense file table — server-paginated, dimmed while a navigation is
            in flight. */}
        <TablePendingBoundary>
          {files.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No files match your filters.
            </p>
          ) : isDeleted ? (
            <ReadOnlyRunFilesTable
              files={files}
              isPending={isPending}
              onReprocess={(id) =>
                handleSingleReprocess(id, startTransition, router)
              }
            />
          ) : (
            <EditableRunFilesTable
              files={files}
              isPending={isPending}
              onUpload={(id) =>
                handleSingleUpload(
                  id,
                  instrumentId,
                  runId,
                  startTransition,
                  router
                )
              }
              onDismiss={(id) =>
                handleSingleDismiss(id, startTransition, router)
              }
              onReprocess={(id) =>
                handleSingleReprocess(id, startTransition, router)
              }
            />
          )}
        </TablePendingBoundary>

        {/* Summary footer */}
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-sm text-muted-foreground">
          <span>
            {pagination.total === 0
              ? `Showing 0 of ${stats.active}`
              : `Showing ${from}–${to} of ${pagination.total}`}
            {stats.dismissed > 0 && filters.files_dismissed
              ? ` (+${stats.dismissed} dismissed)`
              : ""}
          </span>
          <span>
            {stats.pending} pending &middot; {stats.uploaded} uploaded
          </span>
        </div>
      </div>

      <PaginationNav
        page={pagination.page}
        totalPages={pagination.total_pages}
        pageParam="files_page"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bulk handlers — fan out side effects, toast aggregated results, and clear
// the selection. Live in a child component so we can read `actions.clear`
// from the FileSelectionProvider once the operation completes.
// ---------------------------------------------------------------------------

function BulkActionBarHost({
  instrumentId,
  runId,
  isPending,
  startTransition,
}: {
  instrumentId: string;
  runId: string;
  isPending: boolean;
  startTransition: React.TransitionStartFunction;
}) {
  const router = useRouter();
  const { actions } = useFileSelection();

  function handleBulkUpload(ids: number[]) {
    if (ids.length === 0) return;
    startTransition(async () => {
      const res = await fetch(
        `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_ids: ids }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error?.message ?? "Failed to request uploads");
        return;
      }
      toast.success(`Upload requested for ${ids.length} file(s)`);
      actions.clear();
      router.refresh();
    });
  }

  function handleBulkDismiss(ids: number[]) {
    if (ids.length === 0) return;
    startTransition(async () => {
      const results = await Promise.allSettled(
        ids.map((fid) => fetch(`/api/v1/files/${fid}`, { method: "DELETE" }))
      );
      const failed = results.filter(
        (r) =>
          r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)
      ).length;
      if (failed > 0) {
        toast.error(`${failed} file(s) failed to dismiss`);
      } else {
        toast.success(`Dismissed ${ids.length} file(s)`);
      }
      actions.clear();
      router.refresh();
    });
  }

  function handleBulkReprocess(ids: number[]) {
    if (ids.length === 0) return;
    startTransition(async () => {
      const results = await Promise.allSettled(
        ids.map((fid) =>
          fetch(`/api/v1/files/${fid}/reprocess`, { method: "POST" })
        )
      );
      const failed = results.filter(
        (r) =>
          r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)
      ).length;
      const ok = ids.length - failed;
      if (failed === 0) {
        toast.success(`Reprocessing ${ok} file${ok === 1 ? "" : "s"}`);
      } else if (ok === 0) {
        toast.error(`Failed to reprocess ${failed} file(s)`);
      } else {
        toast.warning(
          `Reprocessing ${ok} file${ok === 1 ? "" : "s"}, ${failed} failed`
        );
      }
      actions.clear();
      router.refresh();
    });
  }

  function handleBulkDownload(refs: FileRef[]) {
    if (refs.length === 0) return;
    fanOutFileDownload(refs);
    toast.success(
      `Downloading ${refs.length} file${refs.length === 1 ? "" : "s"}`
    );
  }

  return (
    <FileBulkActionBar
      isPending={isPending}
      onUpload={handleBulkUpload}
      onDismiss={handleBulkDismiss}
      onReprocess={handleBulkReprocess}
      onDownload={handleBulkDownload}
    />
  );
}

// ---------------------------------------------------------------------------
// Per-row single-file handlers. Kept as standalone functions (no closures
// over component state) so the table receives stable callback identities
// across renders.
// ---------------------------------------------------------------------------

function handleSingleUpload(
  fileId: number,
  instrumentId: string,
  runId: string,
  startTransition: React.TransitionStartFunction,
  router: ReturnType<typeof useRouter>
) {
  startTransition(async () => {
    const res = await fetch(
      `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_ids: [fileId] }),
      }
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.error?.message ?? "Failed to request upload");
      return;
    }
    toast.success("Upload requested");
    router.refresh();
  });
}

function handleSingleDismiss(
  fileId: number,
  startTransition: React.TransitionStartFunction,
  router: ReturnType<typeof useRouter>
) {
  startTransition(async () => {
    const res = await fetch(`/api/v1/files/${fileId}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.error?.message ?? "Failed to dismiss file");
      return;
    }
    toast.success("File dismissed");
    router.refresh();
  });
}

function handleSingleReprocess(
  fileId: number,
  startTransition: React.TransitionStartFunction,
  router: ReturnType<typeof useRouter>
) {
  startTransition(async () => {
    const res = await fetch(`/api/v1/files/${fileId}/reprocess`, {
      method: "POST",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.error?.message ?? "Failed to start reprocessing");
      return;
    }
    toast.success("Reprocessing started");
    router.refresh();
  });
}
