"use client";

import { Download, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { debounce, useQueryStates } from "nuqs";
import { useEffect, useTransition } from "react";
import { toast } from "sonner";
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
  RunFileStats,
  RunFilesPage,
} from "@/lib/api/instrument-runs";
import { runDetailSearchParams } from "@/lib/search-params";
import { FileBulkActionBar } from "./file-bulk-action-bar";
import {
  type FileRef,
  FileSelectionProvider,
  useFileSelection,
} from "./file-selection-provider";
import {
  EditableRunFilesTable,
  ReadOnlyRunFilesTable,
} from "./run-files-table";

// Wait this long after the last search keystroke before writing the query to
// the URL and refetching the page.
const SEARCH_DEBOUNCE_MS = 300;

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
  // triggers the RSC refetch and `startTransition` ties it to the table's
  // stale treatment. Discrete controls (status/sort/dismissed/page) update
  // immediately; the free-text search debounces its URL writes per-keystroke
  // (see the input's onChange below). Every filter/sort change also resets
  // `files_page` to 1 so the user never lands on an out-of-range page
  // (default values drop out of the URL via nuqs clearOnDefault).
  const { startTransition: tableStartTransition } = useTablePending();
  const [filters, setFilters] = useQueryStates(runDetailSearchParams, {
    shallow: false,
    startTransition: tableStartTransition,
  });

  // Auto-refresh while work is genuinely in flight (uploading or processing)
  // so the UI picks up status transitions without a manual reload. Files that
  // are merely "detected" (awaiting a manual upload) don't trigger polling.
  const hasInFlight = stats.processing > 0 || stats.uploadRequested > 0;
  useEffect(() => {
    if (!hasInFlight) {
      return;
    }
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
    if (filters.files_dismissed) {
      params.set("dismissed", "true");
    }
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
      <h2 className="font-semibold text-sm">Files</h2>
      <div className="rounded-lg border bg-background dark:bg-muted">
        {/* Toolbar: search, filter, sort */}
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-8 pl-8 text-xs"
              onChange={(e) =>
                setFilters(
                  { files_search: e.target.value, files_page: 1 },
                  // Debounce the URL write (and resulting RSC refetch) so we
                  // only query once the user pauses typing. The input stays
                  // responsive because nuqs updates `filters` optimistically.
                  { limitUrlUpdates: debounce(SEARCH_DEBOUNCE_MS) }
                )
              }
              placeholder="Search files..."
              value={filters.files_search}
            />
          </div>
          <Select
            onValueChange={(v) =>
              setFilters({
                files_status: v as FilesStatusFilter,
                files_page: 1,
              })
            }
            value={filters.files_status}
          >
            <SelectTrigger className="h-8 text-sm" size="sm">
              <SelectValue>
                {filters.files_status === "all"
                  ? `All (${stats.active})`
                  : undefined}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem className="text-sm" value="all">
                All ({stats.active})
              </SelectItem>
              <SelectItem className="text-sm" value="raw">
                Raw
              </SelectItem>
              <SelectItem className="text-sm" value="processed">
                Processed
              </SelectItem>
              <SelectItem className="text-sm" value="pending">
                Pending
              </SelectItem>
              <SelectItem className="text-sm" value="uploaded">
                Uploaded
              </SelectItem>
              <SelectItem className="text-sm" value="processing">
                Processing
              </SelectItem>
              <SelectItem className="text-sm" value="completed">
                Completed
              </SelectItem>
              <SelectItem className="text-sm" value="failed">
                Failed
              </SelectItem>
            </SelectContent>
          </Select>
          <Select
            onValueChange={(v) =>
              setFilters({ files_sort: v as FilesSortField, files_page: 1 })
            }
            value={filters.files_sort}
          >
            <SelectTrigger className="h-8 text-sm" size="sm">
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
              <SelectItem className="text-sm" value="name">
                Sort: Name
              </SelectItem>
              <SelectItem className="text-sm" value="size">
                Sort: Size
              </SelectItem>
              <SelectItem className="text-sm" value="date">
                Sort: Date
              </SelectItem>
              <SelectItem className="text-sm" value="status">
                Sort: Status
              </SelectItem>
            </SelectContent>
          </Select>
          {stats.dismissed > 0 && (
            <Button
              className="h-8 text-sm"
              onClick={() =>
                setFilters({
                  files_dismissed: !filters.files_dismissed,
                  files_page: 1,
                })
              }
              size="sm"
              variant={filters.files_dismissed ? "secondary" : "ghost"}
            >
              {filters.files_dismissed ? "Hide dismissed" : "Show dismissed"}
            </Button>
          )}
          {downloadableCount > 0 && (
            <Button
              className="h-8 gap-1 text-sm"
              onClick={() =>
                archiveActions.start({
                  archiveUrl: downloadHref,
                  runId,
                  defaultFilename: `${runId}.zip`,
                })
              }
              size="sm"
              variant="outline"
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
            isPending={isPending}
            runId={runId}
            startTransition={startTransition}
          />
        )}

        {/* Dense file table — server-paginated, dimmed while a navigation is
            in flight. */}
        <TablePendingBoundary>
          {files.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground text-sm">
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
              onDismiss={(id) =>
                handleSingleDismiss(id, startTransition, router)
              }
              onReprocess={(id) =>
                handleSingleReprocess(id, startTransition, router)
              }
              onUpload={(id) =>
                handleSingleUpload(
                  id,
                  instrumentId,
                  runId,
                  startTransition,
                  router
                )
              }
            />
          )}
        </TablePendingBoundary>

        {/* Summary footer */}
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-muted-foreground text-sm">
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
        pageParam="files_page"
        totalPages={pagination.total_pages}
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
    if (ids.length === 0) {
      return;
    }
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
    if (ids.length === 0) {
      return;
    }
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
    if (ids.length === 0) {
      return;
    }
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
    if (refs.length === 0) {
      return;
    }
    fanOutFileDownload(refs);
    toast.success(
      `Downloading ${refs.length} file${refs.length === 1 ? "" : "s"}`
    );
  }

  return (
    <FileBulkActionBar
      isPending={isPending}
      onDismiss={handleBulkDismiss}
      onDownload={handleBulkDownload}
      onReprocess={handleBulkReprocess}
      onUpload={handleBulkUpload}
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
