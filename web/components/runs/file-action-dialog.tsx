"use client";

import { useId, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { useReturnFocus } from "@/hooks/use-return-focus";
import {
  type FileActionVerb,
  fileActionDialogCopy,
  linkedFilesHelp,
} from "@/lib/runs/file-action-copy";
import type { LinkedFileInfo } from "@/lib/runs/run-file-requests";
import { formatBytes } from "@/lib/utils";

// A file the dialog is about: one of the files the person selected. Its path
// puts it in a folder, which the requests keep together (`fileBatches`).
export interface FileTarget {
  filename: string;
  id: number;
  relativePath: string | null;
  sizeBytes: number | null;
}

// The text of a red confirm button. The `destructive` variant's red on its pale
// red fill is 4.0 to 1, short of the 4.5 to 1 that text needs, so light mode
// uses a darker red: 5.4 to 1. Dark mode keeps the variant's own.
export const DELETE_CONFIRM_CLASS = "text-red-700 dark:text-destructive";

// Where the lookup of linked files stands. The dialog opens before it is done,
// so a person sees the selected files at once.
export type LinkedFilesState =
  | { status: "loading" }
  | { status: "failed" }
  | { files: LinkedFileInfo[]; status: "ready" };

interface FileActionDialogProps {
  files: FileTarget[];
  linked: LinkedFilesState;
  // Called when the person confirms, with whether the linked files go too.
  onConfirm: (includeLinked: boolean) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  verb: FileActionVerb;
}

/**
 * The confirmation for deleting or restoring files: what the action does, the
 * selected files with their sizes, and a checkbox, on by default, that takes
 * the linked files along. Cancel has focus when it opens. The button counts the
 * linked files while the box is checked. Delete is red because it hides files,
 * and Restore is plain.
 *
 * The caller owns the open state, because a dialog opened from state has no
 * trigger for Radix to return focus to, so `useReturnFocus` hands it back to
 * the button that opened it.
 */
export function FileActionDialog({
  files,
  linked,
  onConfirm,
  onOpenChange,
  open,
  verb,
}: FileActionDialogProps) {
  const returnFocus = useReturnFocus();
  const [includeLinked, setIncludeLinked] = useState(true);
  const labelId = useId();
  const helpId = useId();
  const statusId = useId();

  const linkedFiles = linked.status === "ready" ? linked.files : [];
  const copy = fileActionDialogCopy(verb, {
    requested: files.length,
    linked: linkedFiles.length,
    includeLinked,
  });
  // Until the lookup is done the button could miss files that would go along,
  // so it waits. It stays focusable and says why through the status line.
  const waiting = linked.status === "loading";

  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) {
          setIncludeLinked(true);
        }
        onOpenChange(next);
      }}
      open={open}
    >
      <AlertDialogContent {...returnFocus}>
        <AlertDialogHeader>
          <AlertDialogTitle>{copy.title}</AlertDialogTitle>
          <AlertDialogDescription>{copy.description}</AlertDialogDescription>
        </AlertDialogHeader>

        {/* Eight rows of 2rem and their seven dividers fit; a ninth scrolls. */}
        <ul
          aria-label={`Files to ${verb}`}
          className="max-h-[16.5rem] divide-y overflow-y-auto rounded-md border text-sm"
        >
          {files.map((file) => (
            <li
              className="flex h-8 items-center justify-between gap-3 px-3"
              key={file.id}
            >
              <span className="min-w-0 truncate font-mono">
                {file.filename}
              </span>
              <span className="shrink-0 text-muted-foreground tabular-nums">
                {formatBytes(file.sizeBytes)}
              </span>
            </li>
          ))}
        </ul>

        {linked.status === "loading" && (
          <p
            className="text-muted-foreground text-sm"
            id={statusId}
            role="status"
          >
            Checking for linked files…
          </p>
        )}
        {linked.status === "failed" && (
          <p className="text-destructive text-sm" id={statusId} role="alert">
            Couldn’t check for linked files. Only the selected files will be{" "}
            {verb === "delete" ? "deleted" : "restored"}.
          </p>
        )}
        {copy.linkedLabel !== null && (
          <div className="flex items-start gap-3">
            <Checkbox
              aria-describedby={helpId}
              aria-labelledby={labelId}
              checked={includeLinked}
              className="mt-0.5"
              onCheckedChange={(checked) => setIncludeLinked(checked === true)}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5 text-sm">
              <span className="font-medium leading-5" id={labelId}>
                {copy.linkedLabel}
              </span>
              <span className="text-muted-foreground" id={helpId}>
                {linkedFilesHelp(
                  linkedFiles.map((file) => file.relation),
                  files.length
                )}
              </span>
              <ul
                aria-label="Linked files"
                className="max-h-36 overflow-y-auto font-mono text-muted-foreground"
              >
                {linkedFiles.map((file) => (
                  <li className="truncate leading-6" key={file.id}>
                    {file.filename}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            aria-describedby={waiting ? statusId : undefined}
            aria-disabled={waiting}
            className={verb === "delete" ? DELETE_CONFIRM_CLASS : undefined}
            onClick={(event) => {
              if (waiting) {
                event.preventDefault();
                return;
              }
              // Linked files the dialog didn't list, because the lookup
              // failed or found none, never go along.
              onConfirm(copy.includeLinked);
            }}
            variant={verb === "delete" ? "destructive" : "default"}
          >
            {copy.confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
