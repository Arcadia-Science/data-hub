"use client";

import { FileStatusBadge } from "@/components/runs/file-status-badge";
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
import type { RunFile } from "@/lib/api/instrument-runs";
import {
  AlertCircle,
  Download,
  Eye,
  FileText,
  Loader2,
  Upload,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(date: Date | null): string {
  if (!date) return "—";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(date));
}

export function FileCard({
  file,
  instrumentId,
  runId,
  selectable,
  selected,
  onToggle,
}: {
  file: RunFile;
  instrumentId: string;
  runId: string;
  selectable: boolean;
  selected: boolean;
  onToggle: (fileId: number) => void;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const isDismissed = file.deletedAt !== null;
  const isDetected = file.status === "detected";
  const isUploadRequested = file.status === "upload_requested";
  // Files past "uploaded" have already reached S3 and can be downloaded, even if
  // downstream processing failed.
  const isDownloadable = [
    "uploaded",
    "processing",
    "completed",
    "failed",
  ].includes(file.status);
  const isFailed = file.status === "failed";

  // Signals the watcher agent on the instrument PC to transfer this file to S3.
  // The file transitions from "detected" → "upload_requested" until the watcher
  // picks it up and streams the bytes.
  function handleUpload() {
    startTransition(async () => {
      const res = await fetch(
        `/api/v1/instruments/${instrumentId}/runs/${runId}/request-upload`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ file_ids: [file.id] }),
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error?.message ?? "Failed to request upload");
        return;
      }
      toast.success(`Upload requested for ${file.filename}`);
      router.refresh();
    });
  }

  function handleDismiss() {
    startTransition(async () => {
      const res = await fetch(`/api/v1/files/${file.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.error?.message ?? "Failed to dismiss file");
        return;
      }
      toast.success(`Dismissed ${file.filename}`);
      router.refresh();
    });
  }

  const metadataEntries = file.metadata
    ? Object.entries(file.metadata as Record<string, unknown>)
    : [];

  return (
    <div
      className={`flex items-start gap-3 rounded-lg border p-3 ${
        isDismissed ? "border-dashed opacity-50" : ""
      } ${isFailed ? "border-destructive/30 bg-destructive/5" : ""}`}
    >
      {selectable && !isDismissed && (
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggle(file.id)}
          className="mt-1"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-sm font-medium">
            {file.filename}
          </span>
          <FileStatusBadge status={file.status} />
          <Badge variant="outline" className="text-[10px]">
            {file.category}
          </Badge>
          {isDismissed && (
            <Badge variant="secondary" className="text-[10px]">
              Dismissed
            </Badge>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          {file.relativePath && (
            <span className="font-mono">{file.relativePath}</span>
          )}
          <span>{formatBytes(file.sizeBytes)}</span>
          {file.contentType && <span>{file.contentType}</span>}
          <span>Created {formatDate(file.createdAt)}</span>
        </div>

        {isFailed && file.errorMessage && (
          <div className="flex items-start gap-1.5 text-xs text-destructive">
            <AlertCircle className="mt-0.5 size-3 shrink-0" />
            <span>{file.errorMessage}</span>
          </div>
        )}

        {metadataEntries.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 pt-0.5 text-xs text-muted-foreground">
            {metadataEntries.map(([k, v]) => (
              <span key={k}>
                <span className="font-mono">{k}</span>:{" "}
                {Array.isArray(v) ? v.join(", ") : String(v)}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {isDetected && !isDismissed && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              onClick={handleUpload}
              disabled={isPending}
            >
              {isPending ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Upload className="size-3" />
              )}
              Upload
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
                  Dismiss
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Dismiss file?</AlertDialogTitle>
                  <AlertDialogDescription>
                    <strong className="font-mono">{file.filename}</strong> will
                    be soft-deleted. The watcher will skip it on future scans.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={handleDismiss}>
                    Dismiss
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}

        {isUploadRequested && (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Waiting
          </span>
        )}

        {isDownloadable && (
          <div className="flex items-center gap-1">
            {file.contentType?.startsWith("image/") && (
              <Button variant="ghost" size="sm" className="h-7 text-xs" asChild>
                <a
                  href={`/api/v1/files/${file.id}/download`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Eye className="size-3" />
                </a>
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-xs"
              asChild
            >
              <a href={`/api/v1/files/${file.id}/download`}>
                <Download className="size-3" />
                Download
              </a>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
