"use client";

import { useForm } from "@tanstack/react-form";
import { Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import type { FeedbackDraft } from "@/components/feedback/send-feedback-dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
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
  FEEDBACK_DESCRIPTION_MAX,
  FEEDBACK_DETAIL_MAX,
  FEEDBACK_KIND_LABELS,
  FEEDBACK_TITLE_MAX,
  feedbackContentSchema,
  feedbackKindSchema,
} from "@/lib/api/feedback-schema";

function fieldError(error: unknown): string | null {
  if (!error) {
    return null;
  }
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return null;
}

export function SendFeedbackForm({
  draft,
  onDraftChange,
  onSent,
}: {
  draft: FeedbackDraft;
  onDraftChange: (draft: FeedbackDraft) => void;
  onSent: (duplicate: boolean) => void;
}) {
  const [submitError, setSubmitError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const form = useForm({
    defaultValues: draft,
    listeners: {
      onChange: ({ formApi }) => {
        onDraftChange(formApi.state.values);
      },
    },
    onSubmitInvalid: () => {
      if ((titleRef.current?.value ?? "").trim().length === 0) {
        titleRef.current?.focus();
        return;
      }
      descriptionRef.current?.focus();
    },
    onSubmit: async ({ value }) => {
      const parsed = feedbackContentSchema.safeParse(value);
      if (!parsed.success) {
        return;
      }
      setSubmitError(null);
      try {
        const res = await fetch("/api/v1/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind: parsed.data.kind,
            title: parsed.data.title,
            description: parsed.data.description,
            attempted_action: parsed.data.attemptedAction,
            tool_name: parsed.data.toolName,
            error_message: parsed.data.errorMessage,
            page_url: window.location.href.slice(0, FEEDBACK_DETAIL_MAX),
          }),
        });
        if (!res.ok) {
          setSubmitError(
            "Couldn't send feedback. Check your connection and try again."
          );
          return;
        }
        const payload = (await res.json()) as { duplicate?: boolean };
        onSent(payload.duplicate === true);
      } catch {
        setSubmitError(
          "Couldn't send feedback. Check your connection and try again."
        );
      }
    },
  });

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <div className="grid gap-4 py-2">
        <form.Field name="kind">
          {(field) => (
            <div className="grid gap-2">
              <Label htmlFor="feedback-kind">Type</Label>
              <Select
                onValueChange={(value) => {
                  const kind = feedbackKindSchema.parse(value);
                  field.handleChange(kind);
                }}
                value={field.state.value}
              >
                <SelectTrigger
                  className="w-full"
                  id="feedback-kind"
                  name="kind"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {feedbackKindSchema.options.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {FEEDBACK_KIND_LABELS[kind]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </form.Field>

        <form.Field
          name="title"
          validators={{
            onSubmit: ({ value }) => {
              const result = feedbackContentSchema.shape.title.safeParse(value);
              return result.success
                ? undefined
                : (result.error.issues[0]?.message ?? "Enter a title");
            },
          }}
        >
          {(field) => {
            const error = fieldError(field.state.meta.errors[0]);
            return (
              <div className="grid gap-2">
                <Label htmlFor="feedback-title">Title</Label>
                <Input
                  aria-invalid={error ? true : undefined}
                  autoComplete="off"
                  id="feedback-title"
                  maxLength={FEEDBACK_TITLE_MAX}
                  name="title"
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="Export fails on large plate-reader runs…"
                  ref={titleRef}
                  value={field.state.value}
                />
                {error ? (
                  <p className="text-destructive text-sm" role="alert">
                    {error}
                  </p>
                ) : null}
              </div>
            );
          }}
        </form.Field>

        <form.Field
          name="description"
          validators={{
            onSubmit: ({ value }) => {
              const result =
                feedbackContentSchema.shape.description.safeParse(value);
              return result.success
                ? undefined
                : (result.error.issues[0]?.message ?? "Enter a description");
            },
          }}
        >
          {(field) => {
            const error = fieldError(field.state.meta.errors[0]);
            return (
              <div className="grid gap-2">
                <Label htmlFor="feedback-description">Description</Label>
                <Textarea
                  aria-invalid={error ? true : undefined}
                  autoComplete="off"
                  id="feedback-description"
                  maxLength={FEEDBACK_DESCRIPTION_MAX}
                  name="description"
                  onBlur={field.handleBlur}
                  onChange={(event) => field.handleChange(event.target.value)}
                  placeholder="What you expected, and what happened instead…"
                  ref={descriptionRef}
                  rows={5}
                  value={field.state.value}
                />
                {error ? (
                  <p className="text-destructive text-sm" role="alert">
                    {error}
                  </p>
                ) : null}
              </div>
            );
          }}
        </form.Field>

        <Accordion collapsible type="single">
          <AccordionItem value="details">
            <AccordionTrigger className="cursor-pointer items-center py-2.5">
              More details (optional)
            </AccordionTrigger>
            <AccordionContent>
              <div className="grid gap-4 pt-2">
                <form.Field name="attemptedAction">
                  {(field) => (
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
                          field.handleChange(event.target.value)
                        }
                        placeholder="Download the run archive…"
                        rows={3}
                        value={field.state.value}
                      />
                    </div>
                  )}
                </form.Field>
                <form.Field name="toolName">
                  {(field) => (
                    <div className="grid gap-2">
                      <Label htmlFor="feedback-toolName">Tool involved</Label>
                      <Input
                        autoComplete="off"
                        id="feedback-toolName"
                        maxLength={FEEDBACK_DETAIL_MAX}
                        name="toolName"
                        onChange={(event) =>
                          field.handleChange(event.target.value)
                        }
                        placeholder="get_run_report…"
                        spellCheck={false}
                        translate="no"
                        value={field.state.value}
                      />
                    </div>
                  )}
                </form.Field>
                <form.Field name="errorMessage">
                  {(field) => (
                    <div className="grid gap-2">
                      <Label htmlFor="feedback-errorMessage">
                        Error message
                      </Label>
                      <Textarea
                        autoComplete="off"
                        id="feedback-errorMessage"
                        maxLength={FEEDBACK_DETAIL_MAX}
                        name="errorMessage"
                        onChange={(event) =>
                          field.handleChange(event.target.value)
                        }
                        placeholder="Token is missing required scope…"
                        rows={3}
                        spellCheck={false}
                        translate="no"
                        value={field.state.value}
                      />
                    </div>
                  )}
                </form.Field>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        {submitError ? (
          <p aria-live="polite" className="text-destructive text-sm">
            {submitError}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(isSubmitting) => (
            <Button disabled={isSubmitting} type="submit">
              {isSubmitting ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : null}
              {isSubmitting ? "Sending…" : "Send feedback"}
            </Button>
          )}
        </form.Subscribe>
      </DialogFooter>
    </form>
  );
}
