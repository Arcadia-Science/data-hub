"use client";

// Compound component for the org-wide Slack channel webhook section of the
// notifications settings page. Mirrors `slack-connection-card.tsx`: a
// section header above the card and an independent form so dirty state
// stays isolated from in-app and Slack DM prefs.
//
//   <SlackChannelCard.SectionHeader configured={...} />
//   <SlackChannelCard.Form configured={...} lastUpdated={...} />

import { useForm } from "@tanstack/react-form";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { isValidSlackWebhookUrl } from "@/lib/slack/webhook-url";
import { formatRelativeTime } from "@/lib/utils";

function SectionHeader({ configured }: { configured: boolean }) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-lg tracking-tight">Slack channel</h2>
        {configured ? (
          <Badge className="bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300">
            Configured
          </Badge>
        ) : null}
      </div>
      <p className="text-muted-foreground text-sm">
        Post a message to a shared Slack channel whenever a new instrument run
        is reported. This is separate from personal Slack DMs above — channel
        notifications go to everyone in the channel.
      </p>
    </div>
  );
}

interface LastUpdated {
  at: string;
  byEmail: string | null;
  byName: string | null;
}

const formSchema = z.object({
  webhookUrl: z.string().refine(
    (v) => {
      const trimmed = v.trim();
      return trimmed.length === 0 || isValidSlackWebhookUrl(trimmed);
    },
    {
      message:
        "Use a Slack incoming webhook URL (https://hooks.slack.com/services/…).",
    }
  ),
});

// Decoy length only — must not reflect the stored webhook URL.
const MASKED_LENGTH_MIN = 32;
const MASKED_LENGTH_RANGE = 41;

function Form({
  configured,
  lastUpdated,
}: {
  configured: boolean;
  lastUpdated: LastUpdated | null;
}) {
  const router = useRouter();
  const [removing, setRemoving] = useState(false);
  const [isReplacing, setIsReplacing] = useState(false);
  const maskedLength = useMemo(
    () => MASKED_LENGTH_MIN + Math.floor(Math.random() * MASKED_LENGTH_RANGE),
    []
  );

  useEffect(() => {
    if (!configured) {
      setIsReplacing(false);
    }
  }, [configured]);

  const form = useForm({
    defaultValues: { webhookUrl: "" },
    validators: {
      onBlur: formSchema,
      onSubmit: formSchema,
    },
    onSubmit: async ({ value }) => {
      const trimmed = value.webhookUrl.trim();
      if (trimmed.length === 0) {
        return;
      }

      const res = await fetch("/api/v1/settings/slack-channel", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhook_url: trimmed }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(
          body?.error?.message ?? "Couldn't save Slack channel webhook"
        );
        return;
      }

      toast.success("Slack channel webhook saved");
      form.reset({ webhookUrl: "" });
      setIsReplacing(false);
      router.refresh();
    },
  });

  async function handleRemove() {
    setRemoving(true);
    try {
      const res = await fetch("/api/v1/settings/slack-channel", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhook_url: null }),
      });
      if (!res.ok) {
        toast.error("Couldn't remove Slack channel webhook");
        return;
      }
      toast.success("Slack channel webhook removed");
      router.refresh();
    } catch {
      toast.error("Couldn't remove Slack channel webhook");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            e.stopPropagation();
            form.handleSubmit();
          }}
        >
          <FieldGroup>
            <form.Field name="webhookUrl">
              {(field) => {
                const isInvalid =
                  field.state.meta.isTouched && !field.state.meta.isValid;
                const showMasked =
                  configured &&
                  !isReplacing &&
                  field.state.value.trim().length === 0;
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor={field.name}>
                      Incoming webhook URL
                    </FieldLabel>
                    <Input
                      aria-invalid={isInvalid}
                      aria-label={
                        showMasked
                          ? "Webhook configured — focus to replace"
                          : undefined
                      }
                      autoComplete="off"
                      className="font-mono"
                      id={field.name}
                      name={field.name}
                      onBlur={field.handleBlur}
                      onChange={(e) => {
                        setIsReplacing(true);
                        field.handleChange(e.target.value);
                      }}
                      onFocus={() => {
                        if (showMasked) {
                          setIsReplacing(true);
                          field.handleChange("");
                        }
                      }}
                      placeholder="https://hooks.slack.com/services/…"
                      readOnly={showMasked}
                      spellCheck={false}
                      type="password"
                      value={
                        showMasked
                          ? "x".repeat(maskedLength)
                          : field.state.value
                      }
                    />
                    <FieldDescription>
                      {configured ? (
                        "A webhook is configured. Paste a new URL to replace it, or remove the existing webhook below."
                      ) : (
                        <>
                          <a
                            className="text-primary underline underline-offset-2 hover:no-underline"
                            href="https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/"
                            rel="noopener noreferrer"
                            target="_blank"
                          >
                            Create an incoming webhook
                          </a>{" "}
                          in your Slack workspace and paste the URL here.
                        </>
                      )}
                    </FieldDescription>
                    {isInvalid && (
                      <FieldError errors={field.state.meta.errors} />
                    )}
                  </Field>
                );
              }}
            </form.Field>
          </FieldGroup>
        </form>

        <div className="flex items-center justify-between gap-4 border-t pt-4">
          <div className="flex items-center gap-4">
            {configured ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    disabled={removing}
                    onClick={handleRemove}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    {removing ? (
                      <Loader2
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : null}
                    Remove webhook
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  Disable channel notifications and clear the stored webhook
                  URL.
                </TooltipContent>
              </Tooltip>
            ) : null}
            {lastUpdated ? (
              <p
                className="text-muted-foreground text-xs"
                suppressHydrationWarning
              >
                Last updated{" "}
                <span title={new Date(lastUpdated.at).toLocaleString()}>
                  {formatRelativeTime(lastUpdated.at)}
                </span>
                {lastUpdated.byName || lastUpdated.byEmail ? (
                  <>
                    {" by "}
                    <span className="font-medium text-foreground">
                      {lastUpdated.byName ?? lastUpdated.byEmail}
                    </span>
                  </>
                ) : null}
                .
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                No webhook configured yet. Channel notifications are disabled
                until you save a URL.
              </p>
            )}
          </div>
          <form.Subscribe
            selector={(state) => ({
              canSubmit: state.canSubmit,
              isSubmitting: state.isSubmitting,
              isDirty: state.isDirty,
              hasValue: state.values.webhookUrl.trim().length > 0,
            })}
          >
            {({ canSubmit, isSubmitting, isDirty, hasValue }) => (
              <Button
                disabled={!(canSubmit && isDirty && hasValue)}
                onClick={() => form.handleSubmit()}
                type="button"
              >
                {isSubmitting ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" />
                ) : null}
                Save
              </Button>
            )}
          </form.Subscribe>
        </div>
      </CardContent>
    </Card>
  );
}

export const SlackChannelCard = {
  SectionHeader,
  Form,
};
