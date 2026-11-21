"use client";

import { Trash2, TriangleAlert, Upload } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
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
import { useViewerTimeZone } from "@/components/viewer-time-zone-provider";
import { formatLastCheckIn } from "@/lib/instruments/problem-notice";
import { inBatches } from "@/lib/runs/run-file-requests";
import type { UploadFailureGroup } from "@/lib/runs/upload-failure";
import { requestFileUploads } from "@/lib/runs/upload-requests";
import { DELETE_CONFIRM_CLASS } from "./file-action-dialog";
import { deleteFilesAndOfferUndo } from "./file-action-flows";
import { useBumpReportItems } from "./report-items-provider";
import { WatcherGatedUploadButton } from "./watcher-gated-upload-button";

function filesPhrase(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

/**
 * Says which of this run's files the watcher gave up on and why, one block per
 * reason and folder (see `groupUploadFailures`), above the Files section. Each
 * block asks for those files again or deletes them. Hidden when the run has
 * no `upload_failed` files; the layout leaves it out for a deleted run.
 */
export function UploadFailedNotice({
  groups,
  instrumentId,
  runId,
}: {
  groups: UploadFailureGroup[];
  instrumentId: string;
  runId: string;
}) {
  const router = useRouter();
  const timeZone = useViewerTimeZone();
  const titleId = useId();
  const onFilesChanged = useBumpReportItems();
  // The block whose request or delete is running, so its buttons lock.
  const [busy, setBusy] = useState<number | null>(null);

  if (groups.length === 0) {
    return null;
  }

  const total = groups.reduce((sum, group) => sum + group.fileIds.length, 0);

  async function uploadAgain(index: number, group: UploadFailureGroup) {
    setBusy(index);
    const result = await requestFileUploads(instrumentId, runId, group.fileIds);
    if (result.ok) {
      toast.success(
        `Upload requested for ${filesPhrase(group.fileIds.length)}`
      );
    } else {
      toast.error(result.message);
    }
    setBusy(null);
    router.refresh();
  }

  async function deleteGroup(index: number, group: UploadFailureGroup) {
    setBusy(index);
    // These files never reached storage, so nothing is linked to them. The
    // message says how it went and offers Undo, as it does in the files table.
    await deleteFilesAndOfferUndo({
      instrumentId,
      runId,
      batches: inBatches(group.fileIds),
      includeLinked: false,
      onFilesChanged,
      refresh: () => router.refresh(),
    });
    setBusy(null);
  }

  return (
    <section
      aria-labelledby={titleId}
      className="flex gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3.5 text-red-900 text-sm dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-100"
    >
      <TriangleAlert
        aria-hidden="true"
        className="mt-px size-[18px] shrink-0 text-red-700 dark:text-red-400"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <p className="font-semibold" id={titleId}>
          {filesPhrase(total)} couldn’t upload
        </p>
        {groups.map((group, index) => (
          <div
            className="flex flex-col gap-1"
            key={`${group.reason}:${group.folder ?? ""}`}
          >
            <p>
              {groups.length > 1 ? (
                <span className="font-medium">
                  {filesPhrase(group.fileIds.length)}:{" "}
                </span>
              ) : null}
              {group.message}
            </p>
            {group.lastFailedAt ? (
              // "today" and "yesterday" come from the clock, which differs
              // between the server render and hydration around midnight.
              <p
                className="text-red-800 dark:text-red-200"
                suppressHydrationWarning
              >
                The watcher gave up{" "}
                {formatLastCheckIn(new Date(group.lastFailedAt), timeZone)}.
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <WatcherGatedUploadButton
                className="h-7 gap-1.5 bg-background px-2.5 text-xs"
                disabled={busy !== null}
                enabledTooltip={`Request upload for ${filesPhrase(group.fileIds.length)} again`}
                onClick={() => uploadAgain(index, group)}
                size="sm"
                variant="outline"
              >
                <Upload aria-hidden="true" className="size-3.5" />
                Upload again
              </WatcherGatedUploadButton>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button
                    className="h-7 gap-1.5 px-2.5 text-xs"
                    disabled={busy !== null}
                    size="sm"
                    variant="ghost"
                  >
                    <Trash2 aria-hidden="true" className="size-3.5" />
                    Delete these files
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Delete {filesPhrase(group.fileIds.length)}?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      The files will be hidden from this run, and the watcher
                      won’t try to upload them again. You can restore them
                      later. Do this when the files are gone from the instrument
                      PC for good.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      className={DELETE_CONFIRM_CLASS}
                      onClick={() => deleteGroup(index, group)}
                      variant="destructive"
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
