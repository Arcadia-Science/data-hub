"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  FEEDBACK_DETAIL_MAX,
  type FeedbackStatus,
} from "@/lib/api/feedback-schema";

type PendingAction = "decline" | "resolve" | "reopen" | "save";

export function FeedbackStatusForm({
  id,
  note,
  status,
}: {
  id: string;
  note: string | null;
  status: FeedbackStatus;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState(status === "open" ? "" : (note ?? ""));
  const [justSaved, setJustSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null
  );
  const [isPending, startTransition] = useTransition();
  const savedNote = note ?? "";
  const noteUnchanged = draft.trim() === savedNote.trim();

  function submit(nextStatus: FeedbackStatus, action: PendingAction) {
    const nextNote = action === "reopen" ? savedNote : draft;
    setPendingAction(action);
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/v1/feedback/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: nextStatus,
            note: nextNote,
          }),
        });
        if (!res.ok) {
          setError(
            "Couldn't update this report. Refresh the page and try again."
          );
          return;
        }
        if (action === "reopen") {
          setDraft("");
        } else {
          setDraft(nextNote.trim());
        }
        setJustSaved(action === "save");
        router.refresh();
      } catch {
        setError(
          "Couldn't update this report. Check your connection and try again."
        );
      } finally {
        setPendingAction(null);
      }
    });
  }

  let helper =
    "Optional. The reporter sees this note when you resolve or decline.";
  if (status !== "open") {
    helper = justSaved
      ? "Note saved. The reporter was not notified again."
      : "Already sent with the status change. Saving an edit does not notify the reporter again.";
  }

  return (
    <form
      className="flex shrink-0 flex-col gap-2.5 border-t bg-popover px-6 pt-[18px] pb-6"
      onSubmit={(event) => event.preventDefault()}
    >
      <Label htmlFor="feedback-note">Note to reporter</Label>
      <Textarea
        aria-describedby="feedback-note-hint"
        autoComplete="off"
        className="min-h-[84px] resize-y rounded-[10px] px-3 py-2.5 text-sm leading-normal"
        id="feedback-note"
        maxLength={FEEDBACK_DETAIL_MAX}
        name="note"
        onChange={(event) => {
          setDraft(event.target.value);
          setJustSaved(false);
        }}
        placeholder={
          status === "open"
            ? "Explain what you changed, or why you are declining."
            : undefined
        }
        rows={3}
        value={draft}
      />
      <p
        aria-live="polite"
        className="text-[13px] text-zinc-600 leading-snug dark:text-zinc-400"
        id="feedback-note-hint"
      >
        {helper}
      </p>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      {status === "open" ? (
        <OpenActions
          isPending={isPending}
          onDecline={() => submit("declined", "decline")}
          onResolve={() => submit("resolved", "resolve")}
          pendingAction={pendingAction}
        />
      ) : (
        <ClosedActions
          isPending={isPending}
          noteUnchanged={noteUnchanged}
          onReopen={() => submit("open", "reopen")}
          onSave={() => submit(status, "save")}
          pendingAction={pendingAction}
        />
      )}
    </form>
  );
}

function OpenActions({
  isPending,
  onDecline,
  onResolve,
  pendingAction,
}: {
  isPending: boolean;
  onDecline: () => void;
  onResolve: () => void;
  pendingAction: PendingAction | null;
}) {
  return (
    <div className="mt-1 flex gap-3">
      <Button
        className="h-9 flex-1 rounded-[10px]"
        disabled={isPending}
        onClick={onDecline}
        type="button"
        variant="outline"
      >
        {pendingAction === "decline" ? "Declining…" : "Decline"}
      </Button>
      <Button
        className="h-9 flex-1 rounded-[10px]"
        disabled={isPending}
        onClick={onResolve}
        type="button"
      >
        {pendingAction === "resolve" ? "Resolving…" : "Resolve"}
      </Button>
    </div>
  );
}

function ClosedActions({
  isPending,
  noteUnchanged,
  onReopen,
  onSave,
  pendingAction,
}: {
  isPending: boolean;
  noteUnchanged: boolean;
  onReopen: () => void;
  onSave: () => void;
  pendingAction: PendingAction | null;
}) {
  const saveDisabled = isPending || noteUnchanged;
  return (
    <div className="mt-1 flex gap-3">
      <Button
        className="h-9 flex-1 rounded-[10px]"
        disabled={isPending}
        onClick={onReopen}
        type="button"
        variant="outline"
      >
        {pendingAction === "reopen" ? "Reopening…" : "Reopen"}
      </Button>
      <Button
        className="h-9 flex-1 rounded-[10px] disabled:border-zinc-200 disabled:bg-zinc-100 disabled:text-zinc-500 disabled:opacity-100 dark:disabled:border-zinc-700 dark:disabled:bg-zinc-800 dark:disabled:text-zinc-400"
        disabled={saveDisabled}
        onClick={onSave}
        type="button"
      >
        {pendingAction === "save" ? "Saving…" : "Save note"}
      </Button>
    </div>
  );
}
