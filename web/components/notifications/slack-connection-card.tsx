"use client";

// Compound component for the Slack connection section of the notifications
// settings form. Two states are rendered as separate sub-components so the
// parent never needs boolean props to distinguish them:
//
//   <SlackConnectionCard.SectionHeader .../> — title + description above card
//   <SlackConnectionCard.Connected .../>   — shows status + Slack switches
//   <SlackConnectionCard.Disconnected />   — shows "Connect to Slack" CTA

import { useForm } from "@tanstack/react-form";
import { Loader2, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// ---------------------------------------------------------------------------
// Section header — lives above the card, matching the page-level
// Notifications heading pattern in `app/settings/notifications/page.tsx`.
// ---------------------------------------------------------------------------

function SectionHeader({
  connected,
  revoked,
  slackTeamName,
}: {
  connected: boolean;
  revoked: boolean;
  slackTeamName: string | null;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-semibold text-lg tracking-tight">
          Slack notifications
        </h2>
        {connected ? (
          revoked ? (
            <Badge variant="destructive">Reconnect required</Badge>
          ) : (
            <Badge className="bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300">
              Connected{slackTeamName ? ` · ${slackTeamName}` : ""}
            </Badge>
          )
        ) : null}
      </div>
      {connected && revoked ? (
        <p className="flex items-start gap-1.5 text-destructive text-sm">
          <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          The Slack connection is no longer valid. Reconnect to resume DMs.
        </p>
      ) : connected ? (
        <p className="text-muted-foreground text-sm">
          Choose which notification types to also deliver as Slack DMs. In-app
          and Slack are independent — each type can be delivered in-app, via
          Slack, both, or neither.
        </p>
      ) : (
        <p className="text-muted-foreground text-sm">
          Connect your Slack account to receive notifications as personal DMs
          from the Data Hub bot. In-app and Slack are independent — each type
          can be delivered in-app, via Slack, both, or neither.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Disconnected state
// ---------------------------------------------------------------------------

function Disconnected() {
  return (
    <Card>
      <CardContent>
        <Button asChild variant="outline">
          <a href="/api/v1/settings/slack/connect">Connect to Slack</a>
        </Button>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Connected state
// ---------------------------------------------------------------------------

// Slack delivery toggles. The card owns this form outright so its dirty
// state is independent of the in-app notification form — saving one never
// enables the other's Save button.
const slackPreferencesSchema = z.object({
  slackRunsEnabled: z.boolean(),
  slackCommentsAttributedEnabled: z.boolean(),
  slackCommentsParticipatedEnabled: z.boolean(),
});

export type SlackPreferences = z.infer<typeof slackPreferencesSchema>;

function Connected({
  revoked,
  initialPreferences,
}: {
  initialPreferences: SlackPreferences;
  revoked: boolean;
}) {
  const router = useRouter();
  const [disconnecting, setDisconnecting] = useState(false);

  const form = useForm({
    defaultValues: initialPreferences,
    validators: {
      onSubmit: ({ value }) => {
        const result = slackPreferencesSchema.safeParse(value);
        return result.success ? undefined : result.error;
      },
    },
    onSubmit: async ({ value }) => {
      // Partial PUT against the shared notifications endpoint — only the
      // `slack_*` keys, so this save never touches the in-app prefs.
      const res = await fetch("/api/v1/settings/notifications", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slack_runs_enabled: value.slackRunsEnabled,
          slack_comments_attributed_enabled:
            value.slackCommentsAttributedEnabled,
          slack_comments_participated_enabled:
            value.slackCommentsParticipatedEnabled,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(
          body?.error?.message ?? "Couldn't save Slack notification settings"
        );
        return;
      }

      toast.success("Slack notification settings saved");
      // Re-baseline so `isDirty` resets and Save disables until the next edit.
      form.reset(value);
      router.refresh();
    },
  });

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch("/api/v1/settings/slack/disconnect", {
        method: "POST",
      });
      if (!res.ok) {
        toast.error("Couldn't disconnect Slack");
        return;
      }
      toast.success("Slack disconnected");
      router.refresh();
    } catch {
      toast.error("Couldn't disconnect Slack");
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-6">
        {revoked ? (
          <Button asChild variant="outline">
            <a href="/api/v1/settings/slack/connect">Reconnect to Slack</a>
          </Button>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              e.stopPropagation();
              form.handleSubmit();
            }}
          >
            <FieldGroup>
              <form.Field name="slackRunsEnabled">
                {(field) => (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor={field.name}>
                        New instrument runs
                      </FieldLabel>
                      <FieldDescription>
                        DM me when a new run is reported on a subscribed
                        instrument.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      aria-label="Send new run notifications via Slack DM"
                      checked={field.state.value}
                      id={field.name}
                      name={field.name}
                      onCheckedChange={field.handleChange}
                    />
                  </Field>
                )}
              </form.Field>

              <form.Field name="slackCommentsAttributedEnabled">
                {(field) => (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor={field.name}>
                        Comments on runs you ran
                      </FieldLabel>
                      <FieldDescription>
                        DM me when someone comments on a run I&apos;m attributed
                        to.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      aria-label="Send attributed comment notifications via Slack DM"
                      checked={field.state.value}
                      id={field.name}
                      name={field.name}
                      onCheckedChange={field.handleChange}
                    />
                  </Field>
                )}
              </form.Field>

              <form.Field name="slackCommentsParticipatedEnabled">
                {(field) => (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor={field.name}>
                        Replies to your comments
                      </FieldLabel>
                      <FieldDescription>
                        DM me when someone comments on a run I&apos;ve
                        previously commented on.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      aria-label="Send participated comment notifications via Slack DM"
                      checked={field.state.value}
                      id={field.name}
                      name={field.name}
                      onCheckedChange={field.handleChange}
                    />
                  </Field>
                )}
              </form.Field>
            </FieldGroup>
          </form>
        )}

        <div className="flex items-center justify-between gap-4 border-t pt-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                disabled={disconnecting}
                onClick={handleDisconnect}
                size="sm"
                type="button"
                variant="outline"
              >
                {disconnecting ? (
                  <Loader2 className="animate-spin" data-icon="inline-start" />
                ) : null}
                Disconnect Slack
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Remove the Slack connection and disable all Slack DMs.
            </TooltipContent>
          </Tooltip>
          {/* Hidden while revoked: the toggles are replaced by the Reconnect
            CTA above, so there's nothing here to save. */}
          {revoked ? null : (
            <form.Subscribe
              selector={(state) => ({
                canSubmit: state.canSubmit,
                isSubmitting: state.isSubmitting,
                isDirty: state.isDirty,
              })}
            >
              {({ canSubmit, isSubmitting, isDirty }) => (
                <Button
                  disabled={!(canSubmit && isDirty)}
                  onClick={() => form.handleSubmit()}
                  type="button"
                >
                  {isSubmitting ? (
                    <Loader2
                      className="animate-spin"
                      data-icon="inline-start"
                    />
                  ) : null}
                  Save
                </Button>
              )}
            </form.Subscribe>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Public namespace — compound component pattern avoids boolean props.
// ---------------------------------------------------------------------------

export const SlackConnectionCard = {
  SectionHeader,
  Connected,
  Disconnected,
};
