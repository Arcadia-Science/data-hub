"use client";

import { useSession } from "next-auth/react";
import { useEffect, useOptimistic, useState } from "react";
import { RunCommentForm } from "@/components/runs/run-comment-form";
import { RunCommentItem } from "@/components/runs/run-comment-item";
import { Card } from "@/components/ui/card";
import type { RunCommentDto } from "@/lib/api/run-comments";
import { toInitials } from "@/lib/utils";

const COMMENT_HASH_PREFIX = "#comment-";

function scrollToCommentHash() {
  const { hash } = window.location;
  if (!hash.startsWith(COMMENT_HASH_PREFIX)) {
    return;
  }
  document.getElementById(hash.slice(1))?.scrollIntoView({ block: "center" });
}

type Action =
  | { kind: "create"; comment: RunCommentDto }
  | { kind: "update"; commentId: string; body: string; editedAt: Date }
  | { kind: "delete"; commentId: string };

function applyOptimistic(
  current: RunCommentDto[],
  action: Action
): RunCommentDto[] {
  switch (action.kind) {
    case "create":
      if (current.some((c) => c.id === action.comment.id)) {
        return current;
      }
      return [...current, action.comment];
    case "update":
      return current.map((c) =>
        c.id === action.commentId
          ? { ...c, body: action.body, edited_at: action.editedAt }
          : c
      );
    case "delete":
      return current.filter((c) => c.id !== action.commentId);
    default:
      return current;
  }
}

// Owns the create/update/delete actions and the optimistic store. Each
// action dispatches the optimistic state synchronously, then awaits the
// network call. On success, `committed` is updated. On failure, the action
// throws — `useOptimistic` then reverts to `committed` once the calling
// transition unwinds, and the child shows a toast.
//
// `committed` is initialized once from the server-rendered `initialComments`
// prop. We deliberately do not call `router.refresh()` after mutations:
// the local source of truth is `committed`, and refreshing would not
// re-feed it (state is decoupled from props after first render).
export function RunCommentsList({
  instrumentId,
  runId,
  initialComments,
}: {
  instrumentId: string;
  runId: string;
  initialComments: RunCommentDto[];
}) {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id ?? null;

  const [committed, setCommitted] = useState(initialComments);
  const [optimistic, dispatch] = useOptimistic(committed, applyOptimistic);

  // One listener for the whole list (not per-item). Covers initial deep links
  // and same-page `#comment-{id}` changes; `global-search` dispatches
  // `hashchange` after pushState because App Router won't.
  useEffect(() => {
    scrollToCommentHash();
    window.addEventListener("hashchange", scrollToCommentHash);
    return () => window.removeEventListener("hashchange", scrollToCommentHash);
  }, []);

  // Build a comment-shaped object for the optimistic create. The id is a
  // client-generated `temp-…` so the row is keyable; the real id replaces
  // it once the POST resolves and `committed` updates.
  function buildOptimisticComment(body: string): RunCommentDto {
    if (!session?.user?.id) {
      throw new Error("Not authenticated");
    }
    const displayName = session.user.name ?? session.user.email ?? "Unknown";
    return {
      id: `temp-${crypto.randomUUID()}`,
      body,
      user: {
        id: session.user.id,
        displayName,
        initials: toInitials(displayName),
        avatarUrl: session.user.image ?? null,
      },
      created_at: new Date(),
      edited_at: null,
    };
  }

  async function createCommentAction(body: string): Promise<void> {
    const optimisticComment = buildOptimisticComment(body);
    dispatch({ kind: "create", comment: optimisticComment });

    const res = await fetch(
      `/api/v1/instruments/${instrumentId}/runs/${encodeURIComponent(runId)}/comments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      }
    );
    if (!res.ok) {
      throw new Error(await res.text());
    }
    const created = (await res.json()) as RunCommentDto;
    setCommitted((prev) =>
      prev.some((c) => c.id === created.id) ? prev : [...prev, created]
    );
  }

  async function updateCommentAction(
    commentId: string,
    body: string
  ): Promise<void> {
    dispatch({ kind: "update", commentId, body, editedAt: new Date() });

    const res = await fetch(
      `/api/v1/instruments/${instrumentId}/runs/${encodeURIComponent(runId)}/comments/${commentId}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body }),
      }
    );
    if (!res.ok) {
      throw new Error(await res.text());
    }
    const updated = (await res.json()) as RunCommentDto;
    setCommitted((prev) =>
      prev.map((c) => (c.id === updated.id ? updated : c))
    );
  }

  async function deleteCommentAction(commentId: string): Promise<void> {
    dispatch({ kind: "delete", commentId });

    const res = await fetch(
      `/api/v1/instruments/${instrumentId}/runs/${encodeURIComponent(runId)}/comments/${commentId}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      throw new Error(await res.text());
    }
    setCommitted((prev) => prev.filter((c) => c.id !== commentId));
  }

  // Empty + form-only: when there are no comments and no logged-in user,
  // the empty-state message stands alone outside the card stack.
  if (optimistic.length === 0 && !currentUserId) {
    return <p className="text-muted-foreground text-sm">No comments yet.</p>;
  }

  const rowClass = "px-4 py-4 first:pt-1 last:pb-1";

  return (
    <Card className="gap-0 py-0" size="sm">
      <div className="flex flex-col divide-y divide-border">
        {optimistic.length === 0 ? (
          <p className={`${rowClass} text-muted-foreground text-sm`}>
            No comments yet.
          </p>
        ) : (
          optimistic.map((comment) => (
            <div className={rowClass} key={comment.id}>
              <RunCommentItem
                comment={comment}
                currentUserId={currentUserId}
                onDelete={deleteCommentAction}
                onUpdate={updateCommentAction}
              />
            </div>
          ))
        )}

        {currentUserId && (
          <div className={rowClass}>
            <RunCommentForm onSubmit={createCommentAction} />
          </div>
        )}
      </div>
    </Card>
  );
}
