"use client";

import type { FeedbackDraft } from "@/components/feedback/send-feedback-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FEEDBACK_DETAIL_MAX } from "@/lib/api/feedback-schema";

export function FeedbackDetailsFields({
  onChange,
  values,
}: {
  onChange: (patch: Partial<FeedbackDraft>) => void;
  values: Pick<FeedbackDraft, "attemptedAction" | "errorMessage" | "toolName">;
}) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <Label htmlFor="feedback-attemptedAction">
          What were you trying to do?
        </Label>
        <Textarea
          autoComplete="off"
          id="feedback-attemptedAction"
          maxLength={FEEDBACK_DETAIL_MAX}
          name="attemptedAction"
          onChange={(event) =>
            onChange({ attemptedAction: event.target.value })
          }
          placeholder="Download the run archive…"
          rows={3}
          value={values.attemptedAction}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="feedback-toolName">Tool involved</Label>
        <Input
          autoComplete="off"
          id="feedback-toolName"
          maxLength={FEEDBACK_DETAIL_MAX}
          name="toolName"
          onChange={(event) => onChange({ toolName: event.target.value })}
          placeholder="get_run_report…"
          spellCheck={false}
          translate="no"
          value={values.toolName}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="feedback-errorMessage">Error message</Label>
        <Textarea
          autoComplete="off"
          id="feedback-errorMessage"
          maxLength={FEEDBACK_DETAIL_MAX}
          name="errorMessage"
          onChange={(event) => onChange({ errorMessage: event.target.value })}
          placeholder="Token is missing required scope…"
          rows={3}
          spellCheck={false}
          translate="no"
          value={values.errorMessage}
        />
      </div>
    </div>
  );
}
