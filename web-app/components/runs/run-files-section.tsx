"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
import { Download, Loader2, Search, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type MouseEvent,
  useEffect,
  useMemo,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import { RunFilesTable, statusLabel } from "./run-files-table";

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
  | "pending"
  | "uploaded"
  | "processing"
  | "completed"
  | "failed";
type SortField = "name" | "size" | "date" | "status";

const PENDING_STATUSES = new Set(["detected", "upload_requested"]);

function matchesFilter(file: RunFile, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "pending") return PENDING_STATUSES.has(file.status);
  return file.status === filter;
}

// Raw files always come before processed files; the user-selected field
// breaks ties within each category.
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

export function RunFilesSection({
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
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
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

  const selectableFiles = useMemo(
    () => activeFiles.filter((f) => f.status === "detected"),
    [activeFiles]
  );

  const downloadableFiles = useMemo(
    () =>
      activeFiles.filter((f) =>
        ["uploaded", "processing", "completed", "failed"].includes(f.status)
      ),
    [activeFiles]
  );

  const selectedDetectedIds = useMemo(
    () => selectableFiles.filter((f) => selectedIds.has(f.id)).map((f) => f.id),
    [selectableFiles, selectedIds]
  );

  const visibleSelectableIds = useMemo(
    () =>
      new Set(
        paginatedFiles
          .filter((f) => f.status === "detected" && f.deletedAt === null)
          .map((f) => f.id)
      ),
    [paginatedFiles]
  );

  const allVisibleSelected =
    visibleSelectableIds.size > 0 &&
    [...visibleSelectableIds].every((id) => selectedIds.has(id));

  const someVisibleSelected =
    visibleSelectableIds.size > 0 &&
    [...visibleSelectableIds].some((id) => selectedIds.has(id)) &&
    !allVisibleSelected;

  // Summary counts
  const pendingCount = activeFiles.filter((f) =>
    PENDING_STATUSES.has(f.status)
  ).length;
  const uploadedCount = activeFiles.filter(
    (f) => !PENDING_STATUSES.has(f.status) && f.status !== "processing"
  ).length;

  function toggleFile(fileId: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  function toggleAll() {
    if (allVisibleSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleSelectableIds) next.delete(id);
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of visibleSelectableIds) next.add(id);
        return next;
      });
    }
  }

  function handleBulkUpload() {
    if (selectedDetectedIds.length === 0) return;
    startTransition(async () => {
      const res = await fetch(
        `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_ids: selectedDetectedIds }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error?.message ?? "Failed to request uploads");
        return;
      }
      toast.success(
        `Upload requested for ${selectedDetectedIds.length} file(s)`
      );
      setSelectedIds(new Set());
      router.refresh();
    });
  }

  function handleBulkDismiss() {
    if (selectedDetectedIds.length === 0) return;
    startTransition(async () => {
      const results = await Promise.allSettled(
        selectedDetectedIds.map((fid) =>
          fetch(`/api/v1/files/${fid}`, { method: "DELETE" })
        )
      );
      const failed = results.filter(
        (r) =>
          r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok)
      ).length;
      if (failed > 0) {
        toast.error(`${failed} file(s) failed to dismiss`);
      } else {
        toast.success(`Dismissed ${selectedDetectedIds.length} file(s)`);
      }
      setSelectedIds(new Set());
      router.refresh();
    });
  }

  function handleSingleUpload(fileId: number) {
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

  function handleSingleDismiss(fileId: number) {
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

  function handleReprocess(fileId: number) {
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

  const filterLabel =
    statusFilter === "all" ? `All (${activeFiles.length})` : undefined;

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">Files</h2>
      <div className="rounded-lg border">
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
            <SelectTrigger size="sm" className="h-8 text-xs">
              <SelectValue>{filterLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">
                All ({activeFiles.length})
              </SelectItem>
              <SelectItem value="pending" className="text-xs">
                Pending
              </SelectItem>
              <SelectItem value="uploaded" className="text-xs">
                Uploaded
              </SelectItem>
              <SelectItem value="processing" className="text-xs">
                Processing
              </SelectItem>
              <SelectItem value="completed" className="text-xs">
                Completed
              </SelectItem>
              <SelectItem value="failed" className="text-xs">
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
            <SelectTrigger size="sm" className="h-8 text-xs">
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
              <SelectItem value="name" className="text-xs">
                Sort: Name
              </SelectItem>
              <SelectItem value="size" className="text-xs">
                Sort: Size
              </SelectItem>
              <SelectItem value="date" className="text-xs">
                Sort: Date
              </SelectItem>
              <SelectItem value="status" className="text-xs">
                Sort: Status
              </SelectItem>
            </SelectContent>
          </Select>
          {dismissedFiles.length > 0 && (
            <Button
              variant={showDismissed ? "secondary" : "ghost"}
              size="sm"
              className="h-8 text-xs"
              onClick={() => {
                setShowDismissed((p) => !p);
                setPage(1);
              }}
            >
              {showDismissed ? "Hide dismissed" : "Show dismissed"}
            </Button>
          )}
          {downloadableFiles.length > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1 text-xs"
              asChild
            >
              <a
                href={`/api/v1/instruments/${instrumentId}/runs/${runId}/download-archive`}
              >
                <Download className="size-3" />
                Download all
              </a>
            </Button>
          )}
        </div>

        {/* Bulk action bar */}
        {selectedDetectedIds.length > 0 && !isDeleted && (
          <div className="flex items-center gap-2 border-b bg-primary/10 px-3 py-1.5 text-sm">
            <span className="font-medium">
              {selectedDetectedIds.length} selected
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 text-xs text-muted-foreground"
              onClick={() => setSelectedIds(new Set())}
              disabled={isPending}
            >
              <X className="size-3" />
              Clear selection
            </Button>
            <div className="ml-auto flex gap-1">
              <Button
                variant="default"
                size="sm"
                className="h-7 gap-1 text-xs"
                onClick={handleBulkUpload}
                disabled={isPending}
              >
                {isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Upload className="size-3" />
                )}
                Upload {selectedDetectedIds.length}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 text-xs"
                    disabled={isPending}
                  >
                    <X className="size-3" />
                    Dismiss {selectedDetectedIds.length}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Dismiss {selectedDetectedIds.length} file(s)?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      The selected files will be soft-deleted. The watcher will
                      skip them on future scans.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={handleBulkDismiss}>
                      Dismiss
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        )}

        {/* Dense file table */}
        {filteredFiles.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No files match your filters.
          </p>
        ) : (
          <RunFilesTable
            files={paginatedFiles}
            isDeleted={isDeleted}
            isPending={isPending}
            selection={{
              selectedIds,
              visibleSelectableIds,
              allVisibleSelected,
              someVisibleSelected,
              hasBulkSelection: selectedDetectedIds.length > 0,
              onToggleFile: toggleFile,
              onToggleAll: toggleAll,
            }}
            onUpload={handleSingleUpload}
            onDismiss={handleSingleDismiss}
            onReprocess={handleReprocess}
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
