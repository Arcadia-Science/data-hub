"use client";

import { FileCard } from "@/components/runs/file-card";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { RunFile } from "@/lib/api/instrument-runs";
import { CheckSquare, Loader2, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

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

  const activeFiles = useMemo(
    () => files.filter((f) => f.deletedAt === null),
    [files]
  );

  const dismissedFiles = useMemo(
    () => files.filter((f) => f.deletedAt !== null),
    [files]
  );

  const visibleFiles = showDismissed ? files : activeFiles;

  // Only "detected" files (seen by the watcher on disk but not yet in S3) can be
  // selected for bulk upload or dismissal. Files further along the pipeline are
  // already being processed or stored.
  const selectableFiles = useMemo(
    () => activeFiles.filter((f) => f.status === "detected"),
    [activeFiles]
  );

  const selectedDetectedIds = useMemo(
    () => selectableFiles.filter((f) => selectedIds.has(f.id)).map((f) => f.id),
    [selectableFiles, selectedIds]
  );

  const allDetectedSelected =
    selectableFiles.length > 0 &&
    selectableFiles.every((f) => selectedIds.has(f.id));

  function toggleFile(fileId: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(fileId)) next.delete(fileId);
      else next.add(fileId);
      return next;
    });
  }

  function selectAllDetected() {
    setSelectedIds(new Set(selectableFiles.map((f) => f.id)));
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

  // Dismiss = soft-delete. No batch endpoint exists, so individual DELETEs are
  // fanned out in parallel. The watcher will skip dismissed files on future scans.
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

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>
            Files{" "}
            <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">
              {activeFiles.length}
              {dismissedFiles.length > 0 &&
                ` (+${dismissedFiles.length} dismissed)`}
            </span>
          </span>
          <div className="flex items-center gap-2">
            {!isDeleted &&
              selectableFiles.length > 0 &&
              !allDetectedSelected && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={selectAllDetected}
                >
                  <CheckSquare className="size-3" />
                  Select all
                </Button>
              )}
            {dismissedFiles.length > 0 && (
              <>
                <Label
                  htmlFor="show-dismissed"
                  className="text-xs font-normal text-muted-foreground"
                >
                  Show dismissed
                </Label>
                <Switch
                  id="show-dismissed"
                  size="sm"
                  checked={showDismissed}
                  onCheckedChange={setShowDismissed}
                />
              </>
            )}
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {selectedDetectedIds.length > 0 && !isDeleted && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              {selectedDetectedIds.length} selected
            </span>
            <div className="ml-auto flex gap-1">
              <Button
                variant="outline"
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
                Upload selected
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 text-xs text-muted-foreground"
                    disabled={isPending}
                  >
                    <X className="size-3" />
                    Dismiss selected
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

        {visibleFiles.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No files for this run.
          </p>
        ) : (
          visibleFiles.map((file) => (
            <FileCard
              key={file.id}
              file={file}
              instrumentId={instrumentId}
              runId={runId}
              selectable={
                !isDeleted &&
                file.status === "detected" &&
                file.deletedAt === null
              }
              selected={selectedIds.has(file.id)}
              onToggle={toggleFile}
            />
          ))
        )}
      </CardContent>
    </Card>
  );
}
