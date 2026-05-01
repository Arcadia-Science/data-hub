"use client";

import { RunCommentForm } from "@/components/runs/run-comment-form";
import { RunCommentItem } from "@/components/runs/run-comment-item";
import { Card } from "@/components/ui/card";
import type { RunCommentDto } from "@/lib/api/run-comments";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useOptimistic, useState, useTransition } from "react";

type Action =
  | { kind: "create"; comment: RunCommentDto }
  | { kind: "update"; comment: RunCommentDto }
  | { kind: "delete"; commentId: string };

function applyOptimistic(
  current: RunCommentDto[],
  action: Action
): RunCommentDto[] {
  switch (action.kind) {
    case "create":
      if (current.some((c) => c.id === action.comment.id)) return current;
      return [...current, action.comment];
    case "update":
      return current.map((c) =>
        c.id === action.comment.id ? action.comment : c
      );
    case "delete":
      return current.filter((c) => c.id !== action.commentId);
  }
}

// Owns the optimistic state for create/update/delete and reconciles by
// calling `router.refresh()` after each mutation. The server-rendered
// `initialComments` props feed the optimistic store.
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
  const router = useRouter();
  const [, startTransition] = useTransition();

  // Server reconciliations land here; optimistic dispatches layer on top.
  const [committed, setCommitted] = useState(initialComments);
  const [optimistic, dispatch] = useOptimistic(committed, applyOptimistic);

  function handleCreated(comment: RunCommentDto) {
    startTransition(() => {
      dispatch({ kind: "create", comment });
      setCommitted((prev) =>
        prev.some((c) => c.id === comment.id) ? prev : [...prev, comment]
      );
      router.refresh();
    });
  }

  function handleUpdated(comment: RunCommentDto) {
    startTransition(() => {
      dispatch({ kind: "update", comment });
      setCommitted((prev) =>
        prev.map((c) => (c.id === comment.id ? comment : c))
      );
      router.refresh();
    });
  }

  function handleDeleted(commentId: string) {
    startTransition(() => {
      dispatch({ kind: "delete", commentId });
      setCommitted((prev) => prev.filter((c) => c.id !== commentId));
      router.refresh();
    });
  }

  // Empty + form-only: when there are no comments and no logged-in user,
  // the empty-state message stands alone outside the card stack.
  if (optimistic.length === 0 && !currentUserId) {
    return <p className="text-sm text-muted-foreground">No comments yet.</p>;
  }

  const rowClass = "px-4 py-4 first:pt-1 last:pb-1";

  return (
    <Card size="sm" className="gap-0 py-0">
      <div className="flex flex-col divide-y divide-border">
        {optimistic.length === 0 ? (
          <p className={`${rowClass} text-sm text-muted-foreground`}>
            No comments yet.
          </p>
        ) : (
          optimistic.map((comment) => (
            <div key={comment.id} className={rowClass}>
              <RunCommentItem
                comment={comment}
                instrumentId={instrumentId}
                runId={runId}
                currentUserId={currentUserId}
                onUpdated={handleUpdated}
                onDeleted={handleDeleted}
              />
            </div>
          ))
        )}

        {currentUserId && (
          <div className={rowClass}>
            <RunCommentForm
              instrumentId={instrumentId}
              runId={runId}
              onCreated={handleCreated}
            />
          </div>
        )}
      </div>
    </Card>
  );
}
