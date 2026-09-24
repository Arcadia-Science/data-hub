"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { FeedbackKind } from "@/lib/api/feedback-schema";

const SendFeedbackForm = dynamic(
  () =>
    import("@/components/feedback/send-feedback-form").then(
      (mod) => mod.SendFeedbackForm
    ),
  {
    loading: () => <p className="text-muted-foreground text-sm">Loading…</p>,
  }
);

export interface FeedbackDraft {
  attemptedAction: string;
  description: string;
  errorMessage: string;
  kind: FeedbackKind;
  title: string;
  toolName: string;
}

export const EMPTY_FEEDBACK_DRAFT: FeedbackDraft = {
  kind: "bug",
  title: "",
  description: "",
  attemptedAction: "",
  toolName: "",
  errorMessage: "",
};

type View = { kind: "form" } | { duplicate: boolean; kind: "sent" };

export function preloadSendFeedbackForm() {
  void import("@/components/feedback/send-feedback-form");
}

export function SendFeedbackDialog({
  onOpenChange,
  open,
}: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
}) {
  const [view, setView] = useState<View>({ kind: "form" });
  const [draft, setDraft] = useState<FeedbackDraft>(EMPTY_FEEDBACK_DRAFT);

  return (
    <Dialog
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next && view.kind === "sent") {
          setView({ kind: "form" });
          setDraft(EMPTY_FEEDBACK_DRAFT);
        }
      }}
      open={open}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto overscroll-contain sm:max-w-lg">
        {view.kind === "sent" ? (
          <DialogHeader>
            <DialogTitle>Feedback sent</DialogTitle>
            <DialogDescription>
              {view.kind === "sent" && view.duplicate
                ? "You already sent a report with this title, and it is still open. We kept that one."
                : "Workspace admins can see this report. You’ll get a notification when someone resolves or declines it."}
            </DialogDescription>
          </DialogHeader>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Send feedback</DialogTitle>
              <DialogDescription>
                Report a bug or request about Data Hub. Problems with a specific
                run belong in a comment on that run.
              </DialogDescription>
            </DialogHeader>
            <SendFeedbackForm
              draft={draft}
              onDraftChange={setDraft}
              onSent={(duplicate) => {
                setDraft(EMPTY_FEEDBACK_DRAFT);
                setView({ kind: "sent", duplicate });
              }}
            />
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
