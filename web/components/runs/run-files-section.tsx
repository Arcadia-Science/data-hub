"use client";

import { Download, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { debounce, useQueryStates } from "nuqs";
import { toast } from "sonner";
import { PaginationNav } from "@/components/pagination-nav";
import {
  FilesFilterCombobox,
  type FilesFilterOption,
} from "@/components/runs/files-filter-combobox";
import { RunSectionHeading } from "@/components/runs/run-section-heading";
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
  FilesCategoryFilter,
  FilesLifecycleFilter,
  FilesSortField,
  RunFileRow,
  RunFileStats,
  RunFilesPage,
} from "@/lib/api/instrument-runs";
import type { InstrumentType } from "@/lib/db/schema";
import { buildArchiveHref } from "@/lib/runs/archive-href";
import { runDetailSearchParams } from "@/lib/search-params";
import { FileBulkActionBar } from "./file-bulk-action-bar";
import {
  type FileRef,
  FileSelectionProvider,
  useFileSelection,
} from "./file-selection-provider";
import {
  RunAutoRefreshProvider,
  useRunAutoRefresh,
} from "./run-auto-refresh-provider";
import {
  EditableRunFilesTable,
  ReadOnlyRunFilesTable,
} from "./run-files-table";
import { type TrackFiles, usePendingFiles } from "./use-pending-files";

// Wait this long after the last search keystroke before writing the query to
// the URL and refetching the page.
const SEARCH_DEBOUNCE_MS = 300;

function formatFilesSectionCount(stats: RunFileStats): string | undefined {
  const parts: string[] = [];
  if (stats.rawActive > 0) {
    parts.push(`${stats.rawActive} raw`);
  }
  if (stats.processedActive > 0) {
    parts.push(`${stats.processedActive} processed`);
  }
  return parts.length > 0 ? parts.join(", ") : undefined;
}

const FILES_CATEGORY_OPTIONS: FilesFilterOption<FilesCategoryFilter>[] = [
  { value: "raw", label: "Raw" },
  { value: "processed", label: "Processed" },
];

// "Processing" is in-flight work only; files past the stall cutoff answer to
// "Stalled" instead, matching what the status column labels them.
const FILES_STATUS_OPTIONS: FilesFilterOption<FilesLifecycleFilter>[] = [
  { value: "pending", label: "Pending" },
  { value: "uploaded", label: "Uploaded" },
  { value: "processing", label: "Processing" },
  { value: "stalled", label: "Stalled" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

interface RunFilesSectionProps {
  // Current page of the server-paginated, filtered, sorted file list.
  files: RunFileRow[];
  // Downloadable files matching the active table filters (S3-backed).
  filteredDownloadableCount: number;
  instrumentId: string;
  // Selects the Lambda processor / reprocess gate (not the instrument ID).
  instrumentType: InstrumentType;
  isDeleted: boolean;
  pagination: RunFilesPage["pagination"];
  runId: string;
  // Aggregate per-run counts used for the footer summary, filter labels, and
  // the in-flight auto-refresh signal — independent of the current filter.
  stats: RunFileStats;
}

// Downloads one file through a temporary link. The `download` attribute prompts
// a save; the server's Content-Disposition still decides the filename.
function downloadSingleFile(ref: FileRef) {
  const a = document.createElement("a");
  a.href = `/api/v1/files/${ref.id}/download`;
  a.download = ref.filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function RunFilesSection(props: RunFilesSectionProps) {
  // `detected` files wait for a manual upload, so only uploads and processing
  // keep the page refreshing.
  const hasInFlight =
    props.stats.processingInFlight > 0 || props.stats.uploadRequested > 0;
  // TablePendingProvider wraps the whole section so the toolbar's URL updates
  // and PaginationNav share the same React transition, dimming the table
  // while the next server page streams in. The read-only path additionally
  // skips the selection provider since those runs can't be modified.
  return (
    <RunAutoRefreshProvider hasInFlight={hasInFlight}>
      <TablePendingProvider>
        {props.isDeleted ? (
          <RunFilesSectionContent {...props} />
        ) : (
          <FileSelectionProvider
            files={props.files}
            instrumentType={props.instrumentType}
          >
            <RunFilesSectionContent {...props} />
          </FileSelectionProvider>
        )}
      </TablePendingProvider>
    </RunAutoRefreshProvider>
  );
}

function RunFilesSectionContent({
  files,
  filteredDownloadableCount,
  pagination,
  stats,
  instrumentId,
  instrumentType,
  runId,
  isDeleted,
}: RunFilesSectionProps) {
  const router = useRouter();
  const { actions: autoRefreshActions } = useRunAutoRefresh();
  const { actions: archiveActions } = useArchiveDownload();
  // Mutation transition (upload/dismiss/reprocess), distinct from the table's
  // navigation transition below. `track` also records which files an action
  // covers, so only their rows lock while it runs.
  const { isFilePending, isPending, track } = usePendingFiles();

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

  // The archive route resolves the active filters to a downloadable file set
  // server-side, so "Download all" honors search/category/status/dismissed
  // across every page (not just the rows currently on screen). With no
  // filters active we omit the params so the route's default "all
  // downloadable files" path runs. Arrays use comma format to match nuqs
  // `parseAsArrayOf`.
  const isFilterActive =
    filters.files_search.trim() !== "" ||
    filters.files_category.length > 0 ||
    filters.files_status.length > 0 ||
    filters.files_dismissed;
  const downloadHref = buildArchiveHref(instrumentId, runId, {
    search: filters.files_search,
    categories: filters.files_category,
    statuses: filters.files_status,
    dismissed: filters.files_dismissed,
  });

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
      <RunSectionHeading
        countLabel={formatFilesSectionCount(stats)}
        title="Files"
      />
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
          <FilesFilterCombobox
            aria-label="Filter by file type"
            items={FILES_CATEGORY_OPTIONS}
            onValueChange={(next) =>
              setFilters({ files_category: next, files_page: 1 })
            }
            placeholder="Type"
            value={filters.files_category}
          />
          <FilesFilterCombobox
            aria-label="Filter by file status"
            items={FILES_STATUS_OPTIONS}
            onValueChange={(next) =>
              setFilters({ files_status: next, files_page: 1 })
            }
            placeholder="Status"
            value={filters.files_status}
          />
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
          {downloadableCount > 0 &&
            !(isFilterActive && filteredDownloadableCount === 0) && (
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
                  ? `Download filtered (${filteredDownloadableCount})`
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
            track={track}
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
              instrumentType={instrumentType}
              isFilePending={isFilePending}
              onReprocess={(id) =>
                handleSingleReprocess(
                  id,
                  track,
                  router,
                  autoRefreshActions.restart
                )
              }
            />
          ) : (
            <EditableRunFilesTable
              files={files}
              instrumentType={instrumentType}
              isFilePending={isFilePending}
              onDismiss={(id) => handleSingleDismiss(id, track, router)}
              onReprocess={(id) =>
                handleSingleReprocess(
                  id,
                  track,
                  router,
                  autoRefreshActions.restart
                )
              }
              onUpload={(id) =>
                handleSingleUpload(
                  id,
                  instrumentId,
                  runId,
                  track,
                  router,
                  autoRefreshActions.restart
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
  track,
}: {
  instrumentId: string;
  runId: string;
  isPending: boolean;
  track: TrackFiles;
}) {
  const router = useRouter();
  const { actions: archiveActions } = useArchiveDownload();
  const { actions } = useFileSelection();
  const { actions: autoRefreshActions } = useRunAutoRefresh();

  function handleBulkUpload(ids: number[]) {
    if (ids.length === 0) {
      return;
    }
    track(ids, async () => {
      const res = await fetch(
        `/api/v1/instruments/${instrumentId}/runs/${encodeURIComponent(runId)}/request-upload`,
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
      autoRefreshActions.restart();
      router.refresh();
    });
  }

  function handleBulkDismiss(ids: number[]) {
    if (ids.length === 0) {
      return;
    }
    track(ids, async () => {
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
    track(ids, async () => {
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
      if (ok > 0) {
        autoRefreshActions.restart();
      }
      router.refresh();
    });
  }

  // Browsers allow roughly one download per click and block the rest, so a
  // single file downloads directly and several come as one zip that the
  // archive dialog tracks.
  function handleBulkDownload(refs: FileRef[]) {
    if (refs.length === 0) {
      return;
    }
    if (refs.length === 1) {
      downloadSingleFile(refs[0]);
      toast.success(`Downloading ${refs[0].filename}`);
      return;
    }
    archiveActions.start({
      archiveUrl: buildArchiveHref(instrumentId, runId, {
        fileIds: refs.map((ref) => ref.id),
      }),
      runId,
    });
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
  track: TrackFiles,
  router: ReturnType<typeof useRouter>,
  onWorkStarted: () => void
) {
  track([fileId], async () => {
    const res = await fetch(
      `/api/v1/instruments/${instrumentId}/runs/${encodeURIComponent(runId)}/request-upload`,
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
    onWorkStarted();
    router.refresh();
  });
}

function handleSingleDismiss(
  fileId: number,
  track: TrackFiles,
  router: ReturnType<typeof useRouter>
) {
  track([fileId], async () => {
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
  track: TrackFiles,
  router: ReturnType<typeof useRouter>,
  onWorkStarted: () => void
) {
  track([fileId], async () => {
    const res = await fetch(`/api/v1/files/${fileId}/reprocess`, {
      method: "POST",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      toast.error(body?.error?.message ?? "Failed to start reprocessing");
      return;
    }
    toast.success("Reprocessing started");
    onWorkStarted();
    router.refresh();
  });
}
