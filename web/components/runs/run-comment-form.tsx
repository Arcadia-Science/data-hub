"use client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useState, useTransition, type FormEvent } from "react";
import { toast } from "sonner";

const MAX_BODY_LENGTH = 10_000;

// Standalone form for posting a new comment. Owns only its own draft text
// and pending state; the create action is supplied by the parent so the
// form is decoupled from how comments are persisted (per
// `state-decouple-implementation`).
//
// Submitting wraps the parent's action in a transition so its `dispatch`
// to the optimistic store has an enclosing transition to attach to —
// without that, `useOptimistic` has nothing to revert when the action
// throws.
export function RunCommentForm({
  onSubmit,
}: {
  onSubmit: (body: string) => Promise<void>;
}) {
  const [body, setBody] = useState("");
  const [isPending, startTransition] = useTransition();

  const trimmed = body.trim();
  const tooLong = body.length > MAX_BODY_LENGTH;
  const canSubmit = trimmed.length > 0 && !tooLong && !isPending;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    const submitted = body;
    // Clear immediately for a snappy feel; the optimistic comment carries
    // the text. Restore on failure so the user can retry.
    setBody("");
    startTransition(async () => {
      try {
        await onSubmit(submitted);
      } catch {
        toast.error("Couldn't post comment. Try again?");
        setBody(submitted);
      }
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <Textarea
        placeholder="Add a comment"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={isPending}
        rows={3}
        aria-label="Comment body"
        aria-invalid={tooLong || undefined}
        className="resize-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
      />
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        {tooLong ? (
          <span className="text-destructive">
            {body.length}/{MAX_BODY_LENGTH.toLocaleString()} characters
          </span>
        ) : (
          <span aria-hidden="true" />
        )}
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {isPending ? "Posting…" : "Post comment"}
        </Button>
      </div>
    </form>
  );
}
