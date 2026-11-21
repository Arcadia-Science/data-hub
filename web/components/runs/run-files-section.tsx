"use client";

import { Download, Search, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { debounce, useQueryStates } from "nuqs";
import { type TransitionStartFunction, useTransition } from "react";
import { toast } from "sonner";
import { PaginationNav } from "@/components/pagination-nav";
import { useRunDownloadClaimPrompt } from "@/components/runs/claim-prompt/run-claim-target";
import { FileFiltersCombobox } from "@/components/runs/file-filters-combobox";
import { RunSectionHeading } from "@/components/runs/run-section-heading";
import {
  TablePendingBoundary,
  TablePendingProvider,
  useTablePending,
} from "@/components/table-pending";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useArchiveDownload } from "@/hooks/use-archive-download";
import type {
  RunFileRow,
  RunFileStats,
  RunFilesPage,
} from "@/lib/api/instrument-runs";
import type { InstrumentType } from "@/lib/db/schema";
import { buildArchiveHref } from "@/lib/runs/archive-href";
import { narrowsFileDownload } from "@/lib/runs/file-filters";
import {
  REPROCESS_REQUEST_CONCURRENCY,
  settleWithConcurrency,
} from "@/lib/runs/settle-with-concurrency";
import { dismissFiles, requestFileUploads } from "@/lib/runs/upload-requests";
import { filesShowDeleted, runDetailSearchParams } from "@/lib/search-params";
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
import {
  UploadReasonLine,
  WatcherGatedUploadButton,
} from "./watcher-gated-upload-button";

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

interface RunFilesSectionProps {
  // Deleted files that match the current search and filters, shown or not.
  deletedCount: number;
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
  // `detected` files wait for a manual upload, so only uploads, queued files,
  // and processing keep the page refreshing. Queued files start on their own
  // as processing slots free up.
  const hasInFlight =
    props.stats.processingInFlight > 0 ||
    props.stats.queued > 0 ||
    props.stats.uploadRequested > 0;
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
  deletedCount,
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
  const promptClaim = useRunDownloadClaimPrompt();
  // Mutation transition (upload/dismiss/reprocess), distinct from the table's
  // navigation transition below. It disables the bar and Upload all while a
  // request runs.
  const [isPending, startAction] = useTransition();

  // All search / filter / sort / page state lives in the URL. `shallow:false`
  // triggers the RSC refetch and `startTransition` ties it to the table's
  // stale treatment. Discrete controls (filters/sort/page) update
  // immediately; the free-text search debounces its URL writes per-keystroke
  // (see the input's onChange below). Every filter/sort change also resets
  // `files_page` to 1 so the user never lands on an out-of-range page
  // (default values drop out of the URL via nuqs clearOnDefault).
  const { startTransition: tableStartTransition } = useTablePending();
  const [filters, setFilters] = useQueryStates(runDetailSearchParams, {
    shallow: false,
    startTransition: tableStartTransition,
  });
  const showDeleted = filesShowDeleted(filters);

  // The archive route resolves the active filters to a downloadable file set
  // server-side, so "Download all" honors search/category/status across every
  // page (not just the rows currently on screen). With no filters active we
  // omit the params so the route's default "all downloadable files" path runs.
  // Showing deleted files is not one of them: an archive never holds a deleted
  // file. Arrays use comma format to match nuqs `parseAsArrayOf`.
  const isFilterActive = narrowsFileDownload({
    search: filters.files_search,
    categories: filters.files_category,
    statuses: filters.files_status,
  });
  const downloadHref = buildArchiveHref(instrumentId, runId, {
    search: filters.files_search,
    categories: filters.files_category,
    statuses: filters.files_status,
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

  // The files Upload all queues: every `detected` or `upload_failed` file of
  // the run, not only the page on screen. A deleted run is read-only and can't
  // queue uploads.
  const uploadAllCount = isDeleted ? 0 : stats.detected + stats.uploadFailed;

  return (
    <div className="flex flex-col gap-2">
      <RunSectionHeading
        actions={
          uploadAllCount > 0 ? (
            <div className="flex flex-wrap items-center justify-end gap-x-2.5 gap-y-2">
              <UploadReasonLine />
              <WatcherGatedUploadButton
                disabled={isPending}
                enabledTooltip={`Request upload for ${uploadAllCount} ${uploadAllCount === 1 ? "file" : "files"} still on the instrument PC`}
                onClick={() =>
                  handleUploadAll(
                    instrumentId,
                    runId,
                    startAction,
                    router,
                    autoRefreshActions.restart
                  )
                }
                size="sm"
                type="button"
              >
                <Upload data-icon="inline-start" />
                Upload all ({uploadAllCount})
              </WatcherGatedUploadButton>
            </div>
          ) : undefined
        }
        countLabel={formatFilesSectionCount(stats)}
        title="Files"
      />
      <div className="rounded-lg border bg-background dark:bg-muted">
        {/* Toolbar: search, filters, download. Sorting is on the column
            headers. */}
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
          <div className="relative min-w-0 flex-1 basis-60">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="Search files"
              className="h-8 pl-8 text-xs"
              name="files_search"
              onChange={(e) =>
                setFilters(
                  { files_search: e.target.value, files_page: 1 },
                  // Debounce the URL write (and resulting RSC refetch) so we
                  // only query once the user pauses typing. The input stays
                  // responsive because nuqs updates `filters` optimistically.
                  { limitUrlUpdates: debounce(SEARCH_DEBOUNCE_MS) }
                )
              }
              placeholder="Search files…"
              spellCheck={false}
              type="search"
              value={filters.files_search}
            />
          </div>
          <FileFiltersCombobox
            categories={filters.files_category}
            deletedCount={deletedCount}
            onCategoriesChange={(next) =>
              setFilters({ files_category: next, files_page: 1 })
            }
            onShowDeletedChange={(next) =>
              // The old param goes with it, so turning the filter off works for
              // a saved link that used `files_dismissed`.
              setFilters({
                files_deleted: next,
                files_dismissed: false,
                files_page: 1,
              })
            }
            onStatusesChange={(next) =>
              setFilters({ files_status: next, files_page: 1 })
            }
            showDeleted={showDeleted}
            statuses={filters.files_status}
          />
          {downloadableCount > 0 &&
            !(isFilterActive && filteredDownloadableCount === 0) && (
              <Button
                className="h-8 gap-1 text-sm"
                onClick={() => {
                  archiveActions.start({
                    archiveUrl: downloadHref,
                    runId,
                    defaultFilename: `${runId}.zip`,
                  });
                  promptClaim();
                }}
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

        {/* Dense file table — server-paginated, dimmed while a navigation is
            in flight. */}
        <TablePendingBoundary>
          {files.length === 0 ? (
            <p className="py-8 text-center text-muted-foreground text-sm">
              No files match your filters.
            </p>
          ) : isDeleted ? (
            <ReadOnlyRunFilesTable files={files} />
          ) : (
            <EditableRunFilesTable
              files={files}
              instrumentType={instrumentType}
            />
          )}
        </TablePendingBoundary>

        {/* Summary footer */}
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-muted-foreground text-sm tabular-nums">
          <span>
            {pagination.total === 0
              ? `Showing 0 of ${stats.active}`
              : `Showing ${from}–${to} of ${pagination.total}`}
            {showDeleted && deletedCount > 0
              ? `, including ${deletedCount} deleted`
              : ""}
          </span>
          <span>
            {stats.pending} waiting on the instrument PC &middot;{" "}
            {stats.uploadFailed > 0
              ? `${stats.uploadFailed} couldn't upload · `
              : ""}
            {stats.uploaded} uploaded
          </span>
        </div>
      </div>

      <PaginationNav
        page={pagination.page}
        pageParam="files_page"
        totalPages={pagination.total_pages}
      />

      {/* The bar floats at the bottom of the window, so it can sit anywhere.
          It is provider-driven and only renders when something is selected.
          Read-only runs skip the provider entirely above. */}
      {!isDeleted && (
        <BulkActionBarHost
          instrumentId={instrumentId}
          isPending={isPending}
          runId={runId}
          startAction={startAction}
        />
      )}
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
  startAction,
}: {
  instrumentId: string;
  runId: string;
  isPending: boolean;
  startAction: TransitionStartFunction;
}) {
  const router = useRouter();
  const { actions: archiveActions } = useArchiveDownload();
  const promptClaim = useRunDownloadClaimPrompt();
  const { actions } = useFileSelection();
  const { actions: autoRefreshActions } = useRunAutoRefresh();

  function handleBulkUpload(ids: number[]) {
    if (ids.length === 0) {
      return;
    }
    startAction(async () => {
      // Batched: a selection can span pages and exceed one request's limit.
      const result = await requestFileUploads(instrumentId, runId, ids);
      if (!result.ok) {
        toast.error(result.message);
        // The badge was read at page load, so a refusal means the page is out
        // of date: refresh it so the buttons and the line match the server.
        router.refresh();
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
    startAction(async () => {
      const { failed } = await dismissFiles(ids);
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
    startAction(async () => {
      // A few requests at a time: every request queues a file and may start
      // Lambda processing, so sending all of them at once is a burst.
      const results = await settleWithConcurrency(
        ids,
        REPROCESS_REQUEST_CONCURRENCY,
        (fid) => fetch(`/api/v1/files/${fid}/reprocess`, { method: "POST" })
      );
      const failed = results.filter(
        (r) =>
          r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)
      ).length;
      const ok = ids.length - failed;
      if (failed === 0) {
        toast.success(
          `Queued ${ok} file${ok === 1 ? "" : "s"} for reprocessing`
        );
      } else if (ok === 0) {
        toast.error(`Failed to reprocess ${failed} file(s)`);
      } else {
        toast.warning(
          `Queued ${ok} file${ok === 1 ? "" : "s"} for reprocessing, ${failed} failed`
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
    } else {
      archiveActions.start({
        archiveUrl: buildArchiveHref(instrumentId, runId, {
          fileIds: refs.map((ref) => ref.id),
        }),
        runId,
      });
    }
    promptClaim();
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

// Queues every `detected` file of the run through the run-level endpoint that
// the runs list also uses.
function handleUploadAll(
  instrumentId: string,
  runId: string,
  startAction: TransitionStartFunction,
  router: ReturnType<typeof useRouter>,
  onWorkStarted: () => void
) {
  startAction(async () => {
    const res = await fetch(
      `/api/v1/instruments/${instrumentId}/runs/${encodeURIComponent(runId)}/request-upload-all`,
      { method: "POST" }
    );
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      toast.error(body?.error?.message ?? "Failed to request uploads");
      // The badge was read at page load, so a refusal means the page is out
      // of date: refresh it so the buttons and the line match the server.
      router.refresh();
      return;
    }
    const queued = Number(body?.files_queued ?? 0);
    if (queued === 0) {
      // Another request queued them first, so there was nothing left to ask for.
      toast.info("The files were already requested for upload");
    } else {
      toast.success(
        queued === 1
          ? "Upload requested for 1 file"
          : `Upload requested for ${queued} files`
      );
    }
    onWorkStarted();
    router.refresh();
  });
}
