"use client";

import { useForm, useStore } from "@tanstack/react-form";
import { Loader2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { instrumentNotificationTooltip } from "@/components/notifications/instrument-notification-toggle";
import {
  SlackConnectionCard,
  type SlackPreferences,
} from "@/components/notifications/slack-connection-card";
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
import { useUnsavedChangesWarning } from "@/hooks/use-unsaved-changes-warning";

// In-app delivery toggles only. Slack delivery is a separate form owned by
// `SlackConnectionCard` so the two have independent dirty state; this schema
// is reused for `onSubmit` validation to mirror the server's rule.
const inAppPreferencesSchema = z.object({
  runsAllMuted: z.boolean(),
  commentsAttributedEnabled: z.boolean(),
  commentsParticipatedEnabled: z.boolean(),
  genericEnabled: z.boolean(),
  feedbackUpdatedEnabled: z.boolean(),
  feedbackSubmittedEnabled: z.boolean().optional(),
  uploadFailedEnabled: z.boolean(),
  instrumentOfflineEnabled: z.boolean(),
});

type InAppPreferences = z.infer<typeof inAppPreferencesSchema>;

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
type FormValues = InAppPreferences & {
  perInstrument: Record<string, boolean>;
};

interface Props {
  // Present only for workspace admins. Folded into this form and the Slack
  // card so new-feedback toggles share those Save buttons.
  adminNewFeedback?: {
    inApp: boolean;
    slack: boolean | null;
  };
  initialInstruments: InstrumentRow[];
  // The page supplies both channels' prefs; the in-app subset seeds this
  // form, the Slack subset is handed to `SlackConnectionCard.Connected`.
  initialPreferences: InAppPreferences & SlackPreferences;
  slackConnection: SlackConnectionState;
}

export function NotificationsSettingsForm({
  initialPreferences,
  initialInstruments,
  slackConnection,
  adminNewFeedback,
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

  const prefsForm = useForm({
    defaultValues: {
      runsAllMuted: initialPreferences.runsAllMuted,
      commentsAttributedEnabled: initialPreferences.commentsAttributedEnabled,
      commentsParticipatedEnabled:
        initialPreferences.commentsParticipatedEnabled,
      genericEnabled: initialPreferences.genericEnabled,
      feedbackUpdatedEnabled: initialPreferences.feedbackUpdatedEnabled,
      uploadFailedEnabled: initialPreferences.uploadFailedEnabled,
      instrumentOfflineEnabled: initialPreferences.instrumentOfflineEnabled,
      ...(adminNewFeedback
        ? { feedbackSubmittedEnabled: adminNewFeedback.inApp }
        : {}),
      perInstrument: initialPerInstrument,
    } satisfies FormValues,
    validators: {
      // Only the prefs object has Zod-level validation (booleans only —
      // the per-instrument map is structural). The schema's onSubmit
      // pass acts as a final guard against malformed values.
      onSubmit: ({ value }) => {
        const result = inAppPreferencesSchema.safeParse(value);
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
        generic_enabled: value.genericEnabled,
        feedback_updated_enabled: value.feedbackUpdatedEnabled,
        upload_failed_enabled: value.uploadFailedEnabled,
        instrument_offline_enabled: value.instrumentOfflineEnabled,
        ...(adminNewFeedback
          ? {
              feedback_submitted_enabled: value.feedbackSubmittedEnabled,
            }
          : {}),
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
      // Re-baseline to the just-saved values so the form counts as unchanged
      // and Save disables until the next edit. `router.refresh()` still
      // re-runs the server component to pick up out-of-band changes.
      prefsForm.reset(value);
      router.refresh();
    },
  });

  useUnsavedChangesWarning(
    useStore(prefsForm.store, (state) => !state.isDefaultValue)
  );

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          prefsForm.handleSubmit();
        }}
      >
        <Card>
          <CardContent>
            <FieldGroup>
              <prefsForm.Field name="runsAllMuted">
                {(field) => (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor={field.name}>
                        Mute new-run notifications
                      </FieldLabel>
                      <FieldDescription>
                        When on, new runs on any instrument don&apos;t appear in
                        the bell, which is useful for quiet periods. Slack
                        messages, outage alerts and the instruments you pick
                        below stay as they are.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      aria-label="Mute new-run notifications"
                      checked={field.state.value}
                      id={field.name}
                      name={field.name}
                      onCheckedChange={field.handleChange}
                    />
                  </Field>
                )}
              </prefsForm.Field>

              <prefsForm.Field name="instrumentOfflineEnabled">
                {(field) => (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor={field.name}>
                        Instruments that go offline
                      </FieldLabel>
                      <FieldDescription>
                        Notify me when an instrument I picked below has been
                        offline for 30 minutes, and when it&apos;s back online.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      aria-label="Instruments that go offline"
                      checked={field.state.value}
                      id={field.name}
                      name={field.name}
                      onCheckedChange={field.handleChange}
                    />
                  </Field>
                )}
              </prefsForm.Field>

              <FieldSeparator />

              <prefsForm.Field name="commentsAttributedEnabled">
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
              </prefsForm.Field>

              <prefsForm.Field name="commentsParticipatedEnabled">
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
              </prefsForm.Field>

              <FieldSeparator />

              <prefsForm.Field name="uploadFailedEnabled">
                {(field) => (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor={field.name}>
                        Uploads that failed
                      </FieldLabel>
                      <FieldDescription>
                        Notify me when files I requested couldn&apos;t upload,
                        for example because they&apos;re no longer on the
                        instrument PC.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      aria-label="Notify me when files I requested couldn't upload"
                      checked={field.state.value}
                      id={field.name}
                      name={field.name}
                      onCheckedChange={field.handleChange}
                    />
                  </Field>
                )}
              </prefsForm.Field>

              <FieldSeparator />

              <prefsForm.Field name="genericEnabled">
                {(field) => (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor={field.name}>
                        Service notifications
                      </FieldLabel>
                      <FieldDescription>
                        Messages from integrations and scripts sent via the API
                        — for example, a suggestion that a run might be yours to
                        claim.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      aria-label="Notify me when an integration sends me a notification"
                      checked={field.state.value}
                      id={field.name}
                      name={field.name}
                      onCheckedChange={field.handleChange}
                    />
                  </Field>
                )}
              </prefsForm.Field>

              <prefsForm.Field name="feedbackUpdatedEnabled">
                {(field) => (
                  <Field orientation="horizontal">
                    <FieldContent>
                      <FieldLabel htmlFor={field.name}>
                        Updates on your feedback
                      </FieldLabel>
                      <FieldDescription>
                        Notify me when an admin resolves or declines feedback I
                        sent.
                      </FieldDescription>
                    </FieldContent>
                    <Switch
                      aria-label="Notify me when an admin updates my feedback"
                      checked={field.state.value}
                      id={field.name}
                      name={field.name}
                      onCheckedChange={field.handleChange}
                    />
                  </Field>
                )}
              </prefsForm.Field>

              {adminNewFeedback ? (
                <prefsForm.Field name="feedbackSubmittedEnabled">
                  {(field) => (
                    <Field orientation="horizontal">
                      <FieldContent>
                        <FieldLabel htmlFor={field.name}>
                          New feedback
                        </FieldLabel>
                        <FieldDescription>
                          Show new feedback in the notification bell. Admins get
                          these when someone sends feedback about Data Hub.
                        </FieldDescription>
                      </FieldContent>
                      <Switch
                        aria-label="Notify me in the app when someone sends feedback"
                        checked={field.state.value ?? false}
                        id={field.name}
                        name={field.name}
                        onCheckedChange={field.handleChange}
                      />
                    </Field>
                  )}
                </prefsForm.Field>
              ) : null}
            </FieldGroup>
          </CardContent>

          {initialInstruments.length > 0 ? (
            <>
              <FieldSeparator />
              <CardContent>
                <div className="mb-4">
                  <h3 className="font-medium text-sm">Per-instrument</h3>
                  <p className="text-muted-foreground text-sm">
                    Pick the instruments you want to hear about: their new runs,
                    and when they go offline.
                  </p>
                </div>
                {/* The per-instrument list subscribes only to the new-run
                  mute (a single primitive) for its tooltips, so toggling the
                  mute doesn't re-render every row's local Field. The mute
                  doesn't disable the rows: they also pick outage alerts. */}
                <prefsForm.Subscribe
                  selector={(state) => state.values.runsAllMuted}
                >
                  {(masterMuted) => (
                    <FieldGroup>
                      {initialInstruments.map((row) => (
                        <prefsForm.Field
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
                                </FieldContent>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span className="inline-flex">
                                      <Switch
                                        aria-label={`Notify me about new runs and outages on ${row.displayName}`}
                                        checked={enabled}
                                        id={field.name}
                                        name={field.name}
                                        onCheckedChange={(v) =>
                                          field.handleChange(v)
                                        }
                                      />
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {instrumentNotificationTooltip(
                                      enabled,
                                      masterMuted
                                    )}
                                  </TooltipContent>
                                </Tooltip>
                              </Field>
                            );
                          }}
                        </prefsForm.Field>
                      ))}
                    </FieldGroup>
                  )}
                </prefsForm.Subscribe>
              </CardContent>
            </>
          ) : null}

          <CardFooter className="border-t">
            <div className="flex w-full items-center justify-end gap-4">
              <prefsForm.Subscribe
                selector={(state) => ({
                  canSubmit: state.canSubmit,
                  isSubmitting: state.isSubmitting,
                  isDirty: !state.isDefaultValue,
                })}
              >
                {({ canSubmit, isSubmitting, isDirty }) => (
                  <Button disabled={!(canSubmit && isDirty)} type="submit">
                    {isSubmitting ? (
                      <Loader2
                        className="animate-spin"
                        data-icon="inline-start"
                      />
                    ) : null}
                    Save
                  </Button>
                )}
              </prefsForm.Subscribe>
            </div>
          </CardFooter>
        </Card>
      </form>

      {/* Slack lives outside the in-app form and owns its own form + Save,
        so its toggles and dirty state are fully independent. */}
      <SlackConnectionCard.SectionHeader
        connected={slackConnection.connected}
        revoked={slackConnection.revoked}
        slackTeamName={slackConnection.slackTeamName}
      />
      {slackConnection.connected ? (
        <SlackConnectionCard.Connected
          initialPreferences={{
            slackRunsEnabled: initialPreferences.slackRunsEnabled,
            slackCommentsAttributedEnabled:
              initialPreferences.slackCommentsAttributedEnabled,
            slackCommentsParticipatedEnabled:
              initialPreferences.slackCommentsParticipatedEnabled,
            slackGenericEnabled: initialPreferences.slackGenericEnabled,
            slackFeedbackUpdatedEnabled:
              initialPreferences.slackFeedbackUpdatedEnabled,
            slackUploadFailedEnabled:
              initialPreferences.slackUploadFailedEnabled,
            slackInstrumentOfflineEnabled:
              initialPreferences.slackInstrumentOfflineEnabled,
            ...(adminNewFeedback?.slack === null || !adminNewFeedback
              ? {}
              : {
                  slackFeedbackSubmittedEnabled: adminNewFeedback.slack,
                }),
          }}
          revoked={slackConnection.revoked}
        />
      ) : (
        <SlackConnectionCard.Disconnected />
      )}
    </div>
  );
}
