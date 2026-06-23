"use client";

import { useForm } from "@tanstack/react-form";
import { Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { SlackConnectionCard } from "@/components/notifications/slack-connection-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Mirror of the server's PUT body shape, in form-friendly camelCase. The
// schema is reused for `onSubmit` validation so the client surfaces the
// same validity rule the server enforces.
const preferencesSchema = z.object({
  runsAllMuted: z.boolean(),
  commentsAttributedEnabled: z.boolean(),
  commentsParticipatedEnabled: z.boolean(),
  // Slack delivery toggles — independent of in-app.
  slackRunsEnabled: z.boolean(),
  slackCommentsAttributedEnabled: z.boolean(),
  slackCommentsParticipatedEnabled: z.boolean(),
});

type FormPreferences = z.infer<typeof preferencesSchema>;

interface InstrumentRow {
  displayName: string;
  enabled: boolean;
  instrumentId: string;
}

interface SlackConnectionState {
  connected: boolean;
  revoked: boolean;
  slackTeamName: string | null;
}

// The form's `perInstrument` field is a Record<string, boolean> keyed by
// instrument id. Storing it as a plain map (rather than parallel arrays)
// keeps the per-row Field paths predictable: `perInstrument.${id}`.
type FormValues = FormPreferences & {
  perInstrument: Record<string, boolean>;
};

interface Props {
  initialInstruments: InstrumentRow[];
  initialPreferences: FormPreferences;
  slackConnection: SlackConnectionState;
}

export function NotificationsSettingsForm({
  initialPreferences,
  initialInstruments,
  slackConnection,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Surface the OAuth callback result as a toast. The query param is set
  // by the callback redirect and removed here after being consumed.
  useEffect(() => {
    const slackResult = searchParams.get("slack");
    if (!slackResult) {
      return;
    }

    if (slackResult === "connected") {
      toast.success("Slack connected successfully");
    } else if (slackResult === "cancelled") {
      toast.info("Slack connection cancelled");
    } else if (slackResult === "wrong_workspace") {
      toast.error("Please connect using your organisation's Slack workspace");
    } else {
      toast.error("Couldn't connect Slack — please try again");
    }

    // Remove the query param from the URL without a full reload.
    const params = new URLSearchParams(searchParams.toString());
    params.delete("slack");
    const next = params.size > 0 ? `?${params}` : window.location.pathname;
    window.history.replaceState(null, "", next);
  }, [searchParams]);

  const initialPerInstrument = Object.fromEntries(
    initialInstruments.map((row) => [row.instrumentId, row.enabled])
  );

  const form = useForm({
    defaultValues: {
      ...initialPreferences,
      perInstrument: initialPerInstrument,
    } satisfies FormValues,
    validators: {
      // Only the prefs object has Zod-level validation (booleans only —
      // the per-instrument map is structural). The schema's onSubmit
      // pass acts as a final guard against malformed values.
      onSubmit: ({ value }) => {
        const result = preferencesSchema.safeParse(value);
        return result.success ? undefined : result.error;
      },
    },
    onSubmit: async ({ value }) => {
      // Save in parallel: the prefs payload and any per-instrument PUTs
      // that diverge from their initial state. Tracking the diff (rather
      // than blindly PUTting every row) keeps the request count bounded
      // by what the user actually changed.
      const prefsBody = {
        runs_all_muted: value.runsAllMuted,
        comments_attributed_enabled: value.commentsAttributedEnabled,
        comments_participated_enabled: value.commentsParticipatedEnabled,
        slack_runs_enabled: value.slackRunsEnabled,
        slack_comments_attributed_enabled: value.slackCommentsAttributedEnabled,
        slack_comments_participated_enabled:
          value.slackCommentsParticipatedEnabled,
      };

      const changedInstruments = initialInstruments.filter(
        (row) => value.perInstrument[row.instrumentId] !== row.enabled
      );

      const requests: Promise<Response>[] = [
        fetch("/api/v1/settings/notifications", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(prefsBody),
        }),
        ...changedInstruments.map((row) =>
          fetch(
            `/api/v1/settings/notifications/instruments/${encodeURIComponent(
              row.instrumentId
            )}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                enabled: value.perInstrument[row.instrumentId],
              }),
            }
          )
        ),
      ];

      const results = await Promise.all(requests);
      const failed = results.find((res) => !res.ok);
      if (failed) {
        const body = await failed.json().catch(() => null);
        toast.error(
          body?.error?.message ?? "Couldn't save notification settings"
        );
        return;
      }

      toast.success("Notification settings saved");
      // router.refresh() re-runs the page server component so the
      // form's defaults get re-seeded from the just-saved state.
      router.refresh();
    },
  });

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          form.handleSubmit();
        }}
      >
        <Card>
          <CardContent>
            <FieldGroup>
              <form.Field name="runsAllMuted">
                {(field) => (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor={field.name}>
                        Mute all instrument notifications
                      </FieldLabel>
                      <FieldDescription>
                        When on, you won&apos;t be notified about new runs on
                        any instrument — useful for quiet periods.
                        Per-instrument preferences below are preserved and
                        resume when you unmute.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      aria-label="Mute all instrument notifications"
                      checked={field.state.value}
                      id={field.name}
                      name={field.name}
                      onCheckedChange={field.handleChange}
                    />
                  </Field>
                )}
              </form.Field>

              <FieldSeparator />

              <form.Field name="commentsAttributedEnabled">
                {(field) => (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor={field.name}>
                        Comments on runs you ran
                      </FieldLabel>
                      <FieldDescription>
                        Notify me when someone comments on a run I&apos;m
                        attributed to.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      aria-label="Notify me when someone comments on a run I'm attributed to"
                      checked={field.state.value}
                      id={field.name}
                      name={field.name}
                      onCheckedChange={field.handleChange}
                    />
                  </Field>
                )}
              </form.Field>

              <form.Field name="commentsParticipatedEnabled">
                {(field) => (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor={field.name}>
                        Replies to your comments
                      </FieldLabel>
                      <FieldDescription>
                        Notify me when someone comments on a run I&apos;ve
                        previously commented on.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      aria-label="Notify me when someone replies on a run I've commented on"
                      checked={field.state.value}
                      id={field.name}
                      name={field.name}
                      onCheckedChange={field.handleChange}
                    />
                  </Field>
                )}
              </form.Field>
            </FieldGroup>
          </CardContent>

          {initialInstruments.length > 0 ? (
            <>
              <FieldSeparator />
              <CardContent>
                <div className="mb-4">
                  <h3 className="font-medium text-sm">Per-instrument</h3>
                  <p className="text-muted-foreground text-sm">
                    Pick the instruments you want to be notified about whenever
                    a new run is reported.
                  </p>
                </div>
                {/* The per-instrument list subscribes only to the master-mute
                  boolean (a single primitive), so toggling the master doesn't
                  re-render every row's local Field — instead, each row's
                  Switch is `disabled` when muted. This keeps the per-row
                  subscriptions on their own form.Field renderers. */}
                <form.Subscribe selector={(state) => state.values.runsAllMuted}>
                  {(masterMuted) => (
                    <FieldGroup>
                      {initialInstruments.map((row) => (
                        <form.Field
                          key={row.instrumentId}
                          name={`perInstrument.${row.instrumentId}`}
                        >
                          {(field) => {
                            const enabled = field.state.value as boolean;
                            return (
                              <Field orientation="horizontal">
                                <FieldContent>
                                  <FieldLabel htmlFor={field.name}>
                                    {row.displayName}
                                  </FieldLabel>
                                  <FieldDescription className="font-mono text-xs">
                                    {row.instrumentId}
                                  </FieldDescription>
                                </FieldContent>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="inline-flex">
                                      <Switch
                                        aria-label={`Notify me about new runs on ${row.displayName}`}
                                        checked={enabled && !masterMuted}
                                        disabled={masterMuted}
                                        id={field.name}
                                        name={field.name}
                                        onCheckedChange={(v) =>
                                          field.handleChange(v)
                                        }
                                      />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {masterMuted
                                      ? "All instrument notifications muted"
                                      : enabled
                                        ? "Notifying you about new runs"
                                        : "Click to be notified about new runs"}
                                  </TooltipContent>
                                </Tooltip>
                              </Field>
                            );
                          }}
                        </form.Field>
                      ))}
                    </FieldGroup>
                  )}
                </form.Subscribe>
              </CardContent>
            </>
          ) : null}

          <CardFooter className="border-t">
            <div className="flex w-full items-center justify-end gap-4">
              <form.Subscribe
                selector={(state) => ({
                  canSubmit: state.canSubmit,
                  isSubmitting: state.isSubmitting,
                })}
              >
                {({ canSubmit, isSubmitting }) => (
                  <Button disabled={!canSubmit || isSubmitting} type="submit">
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
            </div>
          </CardFooter>
        </Card>
      </form>

      {/* Slack connection card lives outside the main form so that
        disconnect (an immediate action) doesn't require a Save click.
        The Slack per-type toggles are wired back into the form state
        above so they are persisted on the same Save. */}
      <SlackConnectionCard.SectionHeader
        connected={slackConnection.connected}
        revoked={slackConnection.revoked}
        slackTeamName={slackConnection.slackTeamName}
      />
      {slackConnection.connected ? (
        <form.Subscribe
          selector={(state) => ({
            slackRunsEnabled: state.values.slackRunsEnabled,
            slackCommentsAttributedEnabled:
              state.values.slackCommentsAttributedEnabled,
            slackCommentsParticipatedEnabled:
              state.values.slackCommentsParticipatedEnabled,
          })}
        >
          {(slackValues) => (
            <SlackConnectionCard.Connected
              onSlackCommentsAttributedChange={(v) =>
                form.setFieldValue("slackCommentsAttributedEnabled", v)
              }
              onSlackCommentsParticipatedChange={(v) =>
                form.setFieldValue("slackCommentsParticipatedEnabled", v)
              }
              onSlackRunsChange={(v) =>
                form.setFieldValue("slackRunsEnabled", v)
              }
              revoked={slackConnection.revoked}
              slackCommentsAttributedEnabled={
                slackValues.slackCommentsAttributedEnabled
              }
              slackCommentsParticipatedEnabled={
                slackValues.slackCommentsParticipatedEnabled
              }
              slackRunsEnabled={slackValues.slackRunsEnabled}
            />
          )}
        </form.Subscribe>
      ) : (
        <SlackConnectionCard.Disconnected />
      )}
    </div>
  );
}
