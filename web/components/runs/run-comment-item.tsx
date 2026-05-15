"use client";

import { RelativeTime } from "@/components/dashboard/relative-time";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/textarea";
import type { RunCommentDto } from "@/lib/api/run-comments";
import { Loader2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useState, useTransition } from "react";
import { toast } from "sonner";

// Comment timestamps may arrive as Date objects (server-rendered initial
// payload) or ISO strings (JSON responses to mutations). Normalize to a
// string for the wire-typed `RelativeTime` component.
function toIsoString(value: Date | string): string {
  return typeof value === "string" ? value : new Date(value).toISOString();
}

// Lazy-load the markdown renderer so the ~30 KB react-markdown bundle only
// ships when at least one comment exists on the page (per
// `bundle-dynamic-imports`). SSR is enabled so the initial paint already
// shows comments without a hydration flicker.
const CommentMarkdown = dynamic(
  () => import("./comment-markdown").then((m) => m.CommentMarkdown),
  {
    loading: () => (
      <div className="py-1 text-sm text-muted-foreground">Loading…</div>
    ),
  }
);

const MAX_BODY_LENGTH = 10_000;

export function RunCommentItem({
  comment,
  currentUserId,
  onUpdate,
  onDelete,
}: {
  comment: RunCommentDto;
  currentUserId: string | null;
  onUpdate: (commentId: string, body: string) => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [isSaving, startSavingTransition] = useTransition();
  const [isDeleting, startDeletingTransition] = useTransition();

  const isAuthor = currentUserId !== null && comment.user.id === currentUserId;

  const trimmed = draft.trim();
  const tooLong = draft.length > MAX_BODY_LENGTH;
  const canSave = trimmed.length > 0 && !tooLong && !isSaving;

  function handleSave() {
    if (!canSave) return;
    const submitted = draft;
    // Close the editor immediately — the optimistic state shows the new
    // body. If the action throws, re-open with the draft preserved.
    setIsEditing(false);
    startSavingTransition(async () => {
      try {
        await onUpdate(comment.id, submitted);
      } catch {
        toast.error("Couldn't save changes. Try again?");
        setIsEditing(true);
      }
    });
  }

  function handleDelete(event: React.MouseEvent) {
    // Radix auto-closes on action click; we close manually after success
    // so the dialog stays around if the action throws below.
    event.preventDefault();
    setDeleteOpen(false);
    startDeletingTransition(async () => {
      try {
        await onDelete(comment.id);
      } catch {
        toast.error("Couldn't delete comment. Try again?");
      }
    });
  }

  return (
    <>
      <article className="flex gap-3">
        <Avatar size="sm" className="mt-0.5 shrink-0">
          {comment.user.avatarUrl ? (
            <AvatarImage
              src={comment.user.avatarUrl}
              alt={comment.user.displayName}
            />
          ) : null}
          <AvatarFallback>{comment.user.initials}</AvatarFallback>
        </Avatar>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-start justify-between gap-2">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">
                {comment.user.displayName}
              </span>
              <RelativeTime date={toIsoString(comment.created_at)} />
              {comment.edited_at && (
                <span>
                  (edited <RelativeTime date={toIsoString(comment.edited_at)} />
                  )
                </span>
              )}
            </div>
            {isAuthor && !isEditing && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="-mt-1 -mr-1 size-7 shrink-0 text-muted-foreground/70 hover:text-foreground"
                    aria-label="Comment actions"
                    disabled={isDeleting}
                  >
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-32">
                  <DropdownMenuItem onSelect={() => setIsEditing(true)}>
                    <Pencil className="size-3.5" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={(e) => {
                      e.preventDefault();
                      setDeleteOpen(true);
                    }}
                  >
                    <Trash2 className="size-3.5" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>

          {isEditing ? (
            <div className="flex flex-col gap-2">
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                disabled={isSaving}
                rows={3}
                aria-label="Edit comment"
                aria-invalid={tooLong || undefined}
              />
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                {tooLong ? (
                  <span className="text-destructive">
                    {draft.length}/{MAX_BODY_LENGTH.toLocaleString()} characters
                  </span>
                ) : (
                  <span aria-hidden="true" />
                )}
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDraft(comment.body);
                      setIsEditing(false);
                    }}
                    disabled={isSaving}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleSave}
                    disabled={!canSave}
                  >
                    {isSaving ? "Saving…" : "Save"}
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <CommentMarkdown body={comment.body} />
          )}
        </div>
      </article>

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete comment?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove your comment. This action cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleDelete}
              disabled={isDeleting}
            >
              {isDeleting && <Loader2 className="size-4 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
