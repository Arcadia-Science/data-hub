"use client";

import { Loader2, MoreHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import {
  type MouseEvent,
  type RefObject,
  useRef,
  useState,
  useTransition,
} from "react";
import { toast } from "sonner";
import { EditNotebookDialog } from "@/components/notebooks/edit-notebook-dialog";
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
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRecentNotebooks } from "@/hooks/use-recent-notebooks";
import type { NotebookWire } from "@/lib/api/notebook-wire";
import {
  deleteNotebookMessage,
  notebookPageHref,
} from "@/lib/notebooks/details";
import {
  deleteNotebook,
  NotebookRequestError,
} from "@/lib/runs/notebook-requests";

/**
 * The notebook page's ⋯ menu: Edit details, Copy page link, and Delete. A
 * deleted notebook can't change until it's restored, so its menu has only
 * Copy page link. The dialogs put focus back on the menu's button when they
 * close.
 */
export function NotebookActions({
  notebook,
  viewerId,
}: {
  notebook: NotebookWire;
  viewerId: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const deleted = notebook.deleted_at !== null;

  async function copyPageLink() {
    const href = new URL(notebookPageHref(notebook.id), window.location.origin)
      .href;
    try {
      await navigator.clipboard.writeText(href);
      toast.success("Link copied");
    } catch {
      toast.error("Couldn't copy the link.");
    }
  }

  function openDialog(open: (value: boolean) => void) {
    return (event: Event) => {
      event.preventDefault();
      setMenuOpen(false);
      open(true);
    };
  }

  return (
    <>
      <DropdownMenu onOpenChange={setMenuOpen} open={menuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="Lab notebook actions"
            ref={triggerRef}
            size="icon-sm"
            type="button"
            variant="outline"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-44">
          {deleted ? null : (
            <DropdownMenuItem onSelect={openDialog(setEditOpen)}>
              Edit details
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={copyPageLink}>
            Copy page link
          </DropdownMenuItem>
          {deleted ? null : (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={openDialog(setDeleteOpen)}
                variant="destructive"
              >
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {/* Mounted even for a deleted notebook, so the Delete dialog can
          close itself after the refresh that shows the deletion. */}
      <EditNotebookDialog
        notebook={notebook}
        onOpenChange={setEditOpen}
        open={editOpen}
        returnFocusRef={triggerRef}
        viewerId={viewerId}
      />
      <DeleteNotebookDialog
        notebook={notebook}
        onOpenChange={setDeleteOpen}
        open={deleteOpen}
        returnFocusRef={triggerRef}
      />
    </>
  );
}

function DeleteNotebookDialog({
  notebook,
  open,
  onOpenChange,
  returnFocusRef,
}: {
  notebook: NotebookWire;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const router = useRouter();
  const { forget } = useRecentNotebooks();
  const [isPending, startTransition] = useTransition();

  function handleDelete(event: MouseEvent) {
    // The action button closes the dialog by default. Wait for the result,
    // so a failure leaves the choice on screen.
    event.preventDefault();
    startTransition(async () => {
      try {
        await deleteNotebook(notebook.id);
      } catch (error) {
        toast.error(
          error instanceof NotebookRequestError
            ? error.message
            : "Couldn't delete the lab notebook. Try again?"
        );
        return;
      }
      forget(notebook.id);
      toast.success("Lab notebook deleted");
      // In a transition with the refresh, so the dialog stays until the
      // page shows the notebook as deleted.
      startTransition(() => {
        router.refresh();
        onOpenChange(false);
      });
    });
  }

  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!isPending) {
          onOpenChange(next);
        }
      }}
      open={open}
    >
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef.current;
          if (target?.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this lab notebook?</AlertDialogTitle>
          <AlertDialogDescription>
            {deleteNotebookMessage(notebook.name, notebook.run_count)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending}
            onClick={handleDelete}
            variant="destructive"
          >
            {isPending ? (
              <Loader2 className="animate-spin" data-icon="inline-start" />
            ) : null}
            Delete lab notebook
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
