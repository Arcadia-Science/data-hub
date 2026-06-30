"use client";

import { type FormEvent, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

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
    if (!canSubmit) {
      return;
    }
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
    <form className="flex flex-col gap-2" onSubmit={handleSubmit}>
      <Textarea
        aria-invalid={tooLong || undefined}
        aria-label="Comment body"
        className="resize-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
        disabled={isPending}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Add a comment"
        rows={3}
        value={body}
      />
      <div className="flex items-center justify-between text-muted-foreground text-xs">
        {tooLong ? (
          <span className="text-destructive">
            {body.length}/{MAX_BODY_LENGTH.toLocaleString()} characters
          </span>
        ) : (
          <span aria-hidden="true" />
        )}
        <Button disabled={!canSubmit} size="sm" type="submit">
          {isPending ? "Posting…" : "Post comment"}
        </Button>
      </div>
    </form>
  );
}
