"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { RunFile } from "@/lib/api/instrument-runs";
import { Download, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type MouseEvent,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import { FileBulkActionBar } from "./file-bulk-action-bar";
import {
  type FileRef,
  FileSelectionProvider,
  useFileSelection,
} from "./file-selection-provider";
import {
  EditableRunFilesTable,
  ReadOnlyRunFilesTable,
  statusLabel,
} from "./run-files-table";

const PAGE_SIZE = 10;

function getVisiblePages(
  page: number,
  totalPages: number
): (number | "ellipsis")[] {
  if (totalPages <= 7)
    return Array.from({ length: totalPages }, (_, i) => i + 1);

  const pages: (number | "ellipsis")[] = [1];
  if (page > 3) pages.push("ellipsis");
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, page + 1);
  for (let i = start; i <= end; i++) pages.push(i);
  if (page < totalPages - 2) pages.push("ellipsis");
  if (totalPages > 1) pages.push(totalPages);
  return pages;
}

type StatusFilter =
  | "all"
  | "raw"
  | "processed"
  | "pending"
  | "uploaded"
  | "processing"
  | "completed"
  | "failed";
type SortField = "name" | "size" | "date" | "status";

const PENDING_STATUSES = new Set(["detected", "upload_requested"]);

function matchesFilter(file: RunFile, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "raw") return file.category === "raw";
  if (filter === "processed") return file.category === "processed";
  if (filter === "pending") return PENDING_STATUSES.has(file.status);
  return file.status === filter;
}

function compareByCategory(a: RunFile, b: RunFile): number {
  if (a.category === b.category) return 0;
  return a.category === "raw" ? -1 : 1;
}

function compareByField(a: RunFile, b: RunFile, field: SortField): number {
  switch (field) {
    case "name":
      return a.filename.localeCompare(b.filename);
    case "size":
      return (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0);
    case "date":
      return (
        new Date(a.createdAt ?? 0).getTime() -
        new Date(b.createdAt ?? 0).getTime()
      );
    case "status":
      return statusLabel(a).localeCompare(statusLabel(b));
    default:
      return 0;
  }
}

function compareFiles(a: RunFile, b: RunFile, field: SortField): number {
  return compareByCategory(a, b) || compareByField(a, b, field);
}

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

export function RunFilesSection(props: {
  files: RunFile[];
  instrumentId: string;
  runId: string;
  isDeleted: boolean;
}) {
  // The read-only path doesn't need selection at all. Skip the provider so
  // we don't pay for the context for runs that can't be modified anyway.
  if (props.isDeleted) {
    return <RunFilesSectionContent {...props} />;
  }
  return (
    <FileSelectionProvider>
      <RunFilesSectionContent {...props} />
    </FileSelectionProvider>
  );
}

function RunFilesSectionContent({
  files,
  instrumentId,
  runId,
  isDeleted,
}: {
  files: RunFile[];
  instrumentId: string;
  runId: string;
  isDeleted: boolean;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showDismissed, setShowDismissed] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortField, setSortField] = useState<SortField>("name");
  const [page, setPage] = useState(1);

  const activeFiles = useMemo(
    () => files.filter((f) => f.deletedAt === null),
    [files]
  );

  const dismissedFiles = useMemo(
    () => files.filter((f) => f.deletedAt !== null),
    [files]
  );

  // Auto-refresh while any file is in a transient state so the UI picks up
  // status transitions (e.g. upload_requested → uploaded, processing →
  // completed) without a manual reload.
  const hasInFlight = activeFiles.some(
    (f) => f.status === "processing" || f.status === "upload_requested"
  );
  useEffect(() => {
    if (!hasInFlight) return;
    const id = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(id);
  }, [hasInFlight, router]);

  const baseFiles = showDismissed ? files : activeFiles;

  const filteredFiles = useMemo(() => {
    let result = baseFiles;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((f) => f.filename.toLowerCase().includes(q));
    }
    if (statusFilter !== "all") {
      result = result.filter((f) => matchesFilter(f, statusFilter));
    }
    return [...result].sort((a, b) => compareFiles(a, b, sortField));
  }, [baseFiles, searchQuery, statusFilter, sortField]);

  const totalPages = Math.max(1, Math.ceil(filteredFiles.length / PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);

  const paginatedFiles = useMemo(
    () =>
      filteredFiles.slice(
        (currentPage - 1) * PAGE_SIZE,
        currentPage * PAGE_SIZE
      ),
    [filteredFiles, currentPage]
  );

  const isDownloadable = (f: RunFile) =>
    ["uploaded", "processing", "completed", "failed"].includes(f.status);

  // Files in the *currently filtered* view that are eligible for the
  // archive download. The "Download all" button reflects this set so
  // status/search filters narrow the zip to match what's on screen.
  const filteredDownloadableFiles = useMemo(
    () => filteredFiles.filter(isDownloadable),
    [filteredFiles]
  );

  // When no filters are active, omit `file_ids` so the URL stays short and
  // the archive route falls back to its "all downloadable files in run"
  // path. Otherwise serialize the filtered set so the server zips exactly
  // what the user sees.
  const isFilterActive =
    searchQuery.trim() !== "" || statusFilter !== "all" || showDismissed;
  const downloadHref = isFilterActive
    ? `/api/v1/instruments/${instrumentId}/runs/${runId}/download-archive?file_ids=${filteredDownloadableFiles.map((f) => f.id).join(",")}`
    : `/api/v1/instruments/${instrumentId}/runs/${runId}/download-archive`;

  // Summary counts
  const pendingCount = activeFiles.filter((f) =>
    PENDING_STATUSES.has(f.status)
  ).length;
  const uploadedCount = activeFiles.filter(
    (f) => !PENDING_STATUSES.has(f.status) && f.status !== "processing"
  ).length;

  const filterLabel =
    statusFilter === "all" ? `All (${activeFiles.length})` : undefined;

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
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setPage(1);
              }}
              className="h-8 pl-8 text-xs"
            />
          </div>
          <Select
            value={statusFilter}
            onValueChange={(v) => {
              setStatusFilter(v as StatusFilter);
              setPage(1);
            }}
          >
            <SelectTrigger size="sm" className="h-8 text-sm">
              <SelectValue>{filterLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-sm">
                All ({activeFiles.length})
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
            value={sortField}
            onValueChange={(v) => {
              setSortField(v as SortField);
              setPage(1);
            }}
          >
            <SelectTrigger size="sm" className="h-8 text-sm">
              <SelectValue>
                Sort:{" "}
                {sortField === "name"
                  ? "Name"
                  : sortField === "size"
                    ? "Size"
                    : sortField === "date"
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
          {dismissedFiles.length > 0 && (
            <Button
              variant={showDismissed ? "secondary" : "ghost"}
              size="sm"
              className="h-8 text-sm"
              onClick={() => {
                setShowDismissed((p) => !p);
                setPage(1);
              }}
            >
              {showDismissed ? "Hide dismissed" : "Show dismissed"}
            </Button>
          )}
          {filteredDownloadableFiles.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-sm"
              asChild
            >
              <a href={downloadHref}>
                <Download className="size-3" />
                Download all ({filteredDownloadableFiles.length})
              </a>
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

        {/* Dense file table */}
        {filteredFiles.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No files match your filters.
          </p>
        ) : isDeleted ? (
          <ReadOnlyRunFilesTable
            files={paginatedFiles}
            isPending={isPending}
            onReprocess={(id) =>
              handleSingleReprocess(id, startTransition, router)
            }
          />
        ) : (
          <EditableRunFilesTable
            files={paginatedFiles}
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
            onDismiss={(id) => handleSingleDismiss(id, startTransition, router)}
            onReprocess={(id) =>
              handleSingleReprocess(id, startTransition, router)
            }
          />
        )}

        {/* Summary footer */}
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2 text-sm text-muted-foreground">
          <span>
            {filteredFiles.length === 0
              ? `Showing 0 of ${activeFiles.length}`
              : `Showing ${(currentPage - 1) * PAGE_SIZE + 1}–${Math.min(
                  currentPage * PAGE_SIZE,
                  filteredFiles.length
                )} of ${filteredFiles.length}`}
            {dismissedFiles.length > 0 && showDismissed
              ? ` (+${dismissedFiles.length} dismissed)`
              : ""}
          </span>
          {totalPages > 1 && (
            <Pagination className="mx-0 w-auto justify-end">
              <PaginationContent>
                {(() => {
                  const atPrev = currentPage <= 1;
                  const atNext = currentPage >= totalPages;
                  const go = (target: number) => (e: MouseEvent) => {
                    e.preventDefault();
                    setPage(Math.min(Math.max(1, target), totalPages));
                  };
                  return (
                    <>
                      <PaginationItem>
                        <PaginationPrevious
                          href="#"
                          onClick={go(currentPage - 1)}
                          aria-disabled={atPrev}
                          className={
                            atPrev
                              ? "pointer-events-none opacity-50"
                              : undefined
                          }
                        />
                      </PaginationItem>
                      {getVisiblePages(currentPage, totalPages).map((p, i) =>
                        p === "ellipsis" ? (
                          <PaginationItem key={`ellipsis-${i}`}>
                            <PaginationEllipsis />
                          </PaginationItem>
                        ) : (
                          <PaginationItem key={p}>
                            <PaginationLink
                              href="#"
                              isActive={p === currentPage}
                              onClick={go(p)}
                            >
                              {p}
                            </PaginationLink>
                          </PaginationItem>
                        )
                      )}
                      <PaginationItem>
                        <PaginationNext
                          href="#"
                          onClick={go(currentPage + 1)}
                          aria-disabled={atNext}
                          className={
                            atNext
                              ? "pointer-events-none opacity-50"
                              : undefined
                          }
                        />
                      </PaginationItem>
                    </>
                  );
                })()}
              </PaginationContent>
            </Pagination>
          )}
          <span>
            {pendingCount} pending &middot; {uploadedCount} uploaded
          </span>
        </div>
      </div>
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
