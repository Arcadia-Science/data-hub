"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  FEEDBACK_DETAIL_MAX,
  type FeedbackStatus,
  feedbackStatusSchema,
} from "@/lib/api/feedback-schema";
import { feedbackStatusLabel } from "./feedback-badges";

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
  const [nextStatus, setNextStatus] = useState(status);
  const [nextNote, setNextNote] = useState(note ?? "");
  const [isPending, startTransition] = useTransition();
  const unchanged = nextStatus === status && nextNote === (note ?? "");

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
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
              toast.error(
                "Couldn't update this report. Refresh the page and try again."
              );
              return;
            }
            toast.success("Status updated");
            router.refresh();
          } catch {
            toast.error(
              "Couldn't update this report. Check your connection and try again."
            );
          }
        });
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="feedback-status">Status</Label>
        <Select
          onValueChange={(value) =>
            setNextStatus(feedbackStatusSchema.parse(value))
          }
          value={nextStatus}
        >
          <SelectTrigger className="w-full" id="feedback-status" name="status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {feedbackStatusSchema.options.map((value) => (
              <SelectItem key={value} value={value}>
                {feedbackStatusLabel(value)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="feedback-note">Note to reporter</Label>
        <p className="text-muted-foreground text-sm" id="feedback-note-hint">
          The reporter sees this note when you resolve or decline the report.
          Editing only the note does not send another notification.
        </p>
        <Textarea
          aria-describedby="feedback-note-hint"
          autoComplete="off"
          id="feedback-note"
          maxLength={FEEDBACK_DETAIL_MAX}
          name="note"
          onChange={(event) => setNextNote(event.target.value)}
          placeholder="What you decided, and why…"
          rows={4}
          value={nextNote}
        />
      </div>
      <Button disabled={isPending || unchanged} type="submit">
        {isPending ? (
          <Loader2 className="animate-spin" data-icon="inline-start" />
        ) : null}
        {isPending ? "Updating…" : "Update status"}
      </Button>
    </form>
  );
}
