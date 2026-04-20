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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RunFile } from "@/lib/api/instrument-runs";
import { formatDateTime } from "@/lib/date";
import { formatBytes } from "@/lib/utils";
import { Download, Loader2, Search, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

type StatusFilter =
  | "all"
  | "pending"
  | "uploaded"
  | "processing"
  | "completed"
  | "failed";
type SortField = "name" | "size" | "date" | "status";

const PENDING_STATUSES = new Set(["detected", "upload_requested"]);

function statusLabel(file: RunFile): string {
  if (file.deletedAt !== null) return "Dismissed";
  switch (file.status) {
    case "detected":
    case "upload_requested":
      return "Pending";
    case "uploaded":
      return "Uploaded";
    case "processing":
      return "Processing";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    default:
      return file.status;
  }
}

function StatusBadge({ file }: { file: RunFile }) {
  const label = statusLabel(file);

  switch (label) {
    case "Pending":
      return (
        <Badge
          variant="outline"
          className="border-amber-500/40 bg-amber-500/10 text-amber-400"
        >
          {label}
        </Badge>
      );
    case "Uploaded":
      return <Badge variant="secondary">{label}</Badge>;
    case "Processing":
      return (
        <Badge
          variant="outline"
          className="gap-1 border-blue-500/40 bg-blue-500/10 text-blue-400"
        >
          <Loader2 className="size-3 animate-spin" />
          {label}
        </Badge>
      );
    case "Completed":
      return (
        <Badge
          variant="outline"
          className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
        >
          {label}
        </Badge>
      );
    case "Failed":
      return <Badge variant="destructive">{label}</Badge>;
    case "Dismissed":
      return (
        <Badge variant="secondary" className="opacity-60">
          {label}
        </Badge>
      );
    default:
      return <Badge variant="secondary">{label}</Badge>;
  }
}

function matchesFilter(file: RunFile, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "pending") return PENDING_STATUSES.has(file.status);
  return file.status === filter;
}

function compareFiles(a: RunFile, b: RunFile, field: SortField): number {
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

  const activeFiles = useMemo(
    () => files.filter((f) => f.deletedAt === null),
    [files]
  );

  const dismissedFiles = useMemo(
    () => files.filter((f) => f.deletedAt !== null),
    [files]
  );

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
        filteredFiles
          .filter((f) => f.status === "detected" && f.deletedAt === null)
          .map((f) => f.id)
      ),
    [filteredFiles]
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

  const filterLabel =
    statusFilter === "all" ? `All (${activeFiles.length})` : undefined;

  return (
    <div className="rounded-lg border">
      {/* Toolbar: search, filter, sort */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search files..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as StatusFilter)}
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
          onValueChange={(v) => setSortField(v as SortField)}
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
            onClick={() => setShowDismissed((p) => !p)}
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
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {!isDeleted && visibleSelectableIds.size > 0 && (
                <TableHead className="w-10 pr-0 pl-3">
                  <Checkbox
                    checked={
                      allVisibleSelected
                        ? true
                        : someVisibleSelected
                          ? "indeterminate"
                          : false
                    }
                    onCheckedChange={toggleAll}
                  />
                </TableHead>
              )}
              <TableHead className="text-sm font-medium text-muted-foreground">
                File name
              </TableHead>
              <TableHead className="text-sm font-medium text-muted-foreground">
                Size
              </TableHead>
              <TableHead className="text-sm font-medium text-muted-foreground">
                Created
              </TableHead>
              <TableHead className="text-sm font-medium text-muted-foreground">
                Status
              </TableHead>
              <TableHead className="w-0" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredFiles.map((file) => {
              const isDismissed = file.deletedAt !== null;
              const isSelectable =
                !isDeleted && file.status === "detected" && !isDismissed;
              const isSelected = selectedIds.has(file.id);
              const showRowActions =
                !isDeleted &&
                !isDismissed &&
                file.status === "detected" &&
                selectedDetectedIds.length === 0;

              return (
                <TableRow
                  key={file.id}
                  data-state={isSelected ? "selected" : undefined}
                  className={`group ${isDismissed ? "opacity-50" : ""}`}
                >
                  {!isDeleted && visibleSelectableIds.size > 0 && (
                    <TableCell className="py-2 pr-0 pl-3">
                      {isSelectable ? (
                        <Checkbox
                          checked={isSelected}
                          onCheckedChange={() => toggleFile(file.id)}
                        />
                      ) : (
                        <div className="size-4" />
                      )}
                    </TableCell>
                  )}
                  <TableCell className="py-2 font-mono text-sm">
                    <span className="flex items-center gap-1.5">
                      {file.filename}
                      {[
                        "uploaded",
                        "processing",
                        "completed",
                        "failed",
                      ].includes(file.status) && (
                        <a
                          href={`/api/v1/files/${file.id}/download`}
                          className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                        >
                          <Download className="size-4" />
                        </a>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="py-2 text-sm text-muted-foreground">
                    {formatBytes(file.sizeBytes)}
                  </TableCell>
                  <TableCell className="py-2 text-sm text-muted-foreground">
                    {file.createdAt ? formatDateTime(file.createdAt) : "—"}
                  </TableCell>
                  <TableCell className="py-2">
                    <StatusBadge file={file} />
                  </TableCell>
                  <TableCell className="py-2 pr-3">
                    {showRowActions && (
                      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 gap-1 px-2 text-xs"
                          onClick={() => handleSingleUpload(file.id)}
                          disabled={isPending}
                        >
                          <Upload className="size-3" />
                          Upload
                        </Button>
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-6 gap-1 px-2 text-xs text-muted-foreground"
                              disabled={isPending}
                            >
                              <X className="size-3" />
                              Dismiss
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Dismiss file?</AlertDialogTitle>
                              <AlertDialogDescription>
                                <strong className="font-mono">
                                  {file.filename}
                                </strong>{" "}
                                will be soft-deleted. The watcher will skip it
                                on future scans.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleSingleDismiss(file.id)}
                              >
                                Dismiss
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      {/* Summary footer */}
      <div className="flex items-center justify-between border-t px-3 py-2 text-sm text-muted-foreground">
        <span>
          Showing {filteredFiles.length} of {activeFiles.length}
          {dismissedFiles.length > 0 && showDismissed
            ? ` (+${dismissedFiles.length} dismissed)`
            : ""}
        </span>
        <span>
          {pendingCount} pending &middot; {uploadedCount} uploaded
        </span>
      </div>
    </div>
  );
}
