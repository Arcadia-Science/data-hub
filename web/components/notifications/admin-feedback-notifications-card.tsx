"use client";

import { useForm } from "@tanstack/react-form";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";

export function AdminFeedbackNotificationsCard({
  feedbackSubmittedEnabled,
  slackConnected,
  slackFeedbackSubmittedEnabled,
}: {
  feedbackSubmittedEnabled: boolean;
  slackConnected: boolean;
  slackFeedbackSubmittedEnabled: boolean;
}) {
  const router = useRouter();
  const form = useForm({
    defaultValues: {
      feedbackSubmittedEnabled,
      slackFeedbackSubmittedEnabled,
    },
    onSubmit: async ({ value }) => {
      const res = await fetch("/api/v1/settings/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          feedback_submitted_enabled: value.feedbackSubmittedEnabled,
          slack_feedback_submitted_enabled: value.slackFeedbackSubmittedEnabled,
        }),
      });
      if (!res.ok) {
        toast.error("Couldn't save feedback notification settings");
        return;
      }
      toast.success("Feedback notification settings saved");
      form.reset(value);
      router.refresh();
    },
  });

  return (
    <section className="mt-8 grid gap-3">
      <div>
        <h3 className="font-medium text-sm">New feedback</h3>
        <p className="text-muted-foreground text-sm">
          Admins get these when someone sends feedback about Data Hub.
        </p>
      </div>
      <Card>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <FieldGroup>
              <form.Field name="feedbackSubmittedEnabled">
                {(field) => (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor={field.name}>In the app</FieldLabel>
                      <FieldDescription>
                        Show new feedback in the notification bell.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      aria-label="Notify me in the app when someone sends feedback"
                      checked={field.state.value}
                      id={field.name}
                      name={field.name}
                      onCheckedChange={field.handleChange}
                    />
                  </Field>
                )}
              </form.Field>
              {slackConnected ? (
                <form.Field name="slackFeedbackSubmittedEnabled">
                  {(field) => (
                    <Field orientation="horizontal">
                      <FieldContent>
                        <FieldLabel htmlFor={field.name}>Slack DM</FieldLabel>
                        <FieldDescription>
                          DM me when someone sends feedback.
                        </FieldDescription>
                      </FieldContent>
                      <Switch
                        aria-label="Send new feedback notifications via Slack DM"
                        checked={field.state.value}
                        id={field.name}
                        name={field.name}
                        onCheckedChange={field.handleChange}
                      />
                    </Field>
                  )}
                </form.Field>
              ) : null}
            </FieldGroup>
          </form>
        </CardContent>
        <CardFooter className="justify-end">
          <form.Subscribe
            selector={(state) => ({
              isDirty: state.isDirty,
              isSubmitting: state.isSubmitting,
            })}
          >
            {({ isDirty, isSubmitting }) => (
              <Button
                disabled={!isDirty || isSubmitting}
                onClick={() => void form.handleSubmit()}
                type="button"
              >
                {isSubmitting ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" />
                ) : null}
                {isSubmitting ? "Saving…" : "Save"}
              </Button>
            )}
          </form.Subscribe>
        </CardFooter>
      </Card>
    </section>
  );
}
