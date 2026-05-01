"use client";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { RunCommentDto } from "@/lib/api/run-comments";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

const MAX_BODY_LENGTH = 10_000;

// Standalone form for posting a new comment. Owns only its own draft text
// (per `rerender-defer-reads` — list state stays in the parent provider).
// On success the parent reconciles via the supplied callback; we don't call
// `router.refresh()` here so optimistic state reads aren't blown away.
export function RunCommentForm({
  instrumentId,
  runId,
  onCreated,
}: {
  instrumentId: string;
  runId: string;
  onCreated: (comment: RunCommentDto) => void;
}) {
  const [body, setBody] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const trimmed = body.trim();
  const tooLong = body.length > MAX_BODY_LENGTH;
  const canSubmit = trimmed.length > 0 && !tooLong && !isSubmitting;

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
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
      onCreated(created);
      setBody("");
    } catch {
      toast.error("Couldn't post comment. Try again?");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <Textarea
        placeholder="Add a comment"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        disabled={isSubmitting}
        rows={3}
        aria-label="Comment body"
        aria-invalid={tooLong || undefined}
        className="resize-none border-0 px-0 shadow-none focus-visible:ring-0"
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
          {isSubmitting ? "Posting…" : "Post comment"}
        </Button>
      </div>
    </form>
  );
}
