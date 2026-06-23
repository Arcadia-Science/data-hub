"use client";

// Compound component for the Slack connection section of the notifications
// settings form. Two states are rendered as separate sub-components so the
// parent never needs boolean props to distinguish them:
//
//   <SlackConnectionCard.Connected .../>   — shows status + Slack switches
//   <SlackConnectionCard.Disconnected />   — shows "Connect to Slack" CTA

import { BotMessageSquare, Loader2, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
// Disconnected state
// ---------------------------------------------------------------------------

function Disconnected() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BotMessageSquare aria-hidden className="size-4 shrink-0" />
          Slack notifications
        </CardTitle>
        <CardDescription>
          Connect your Slack account to receive notifications as personal DMs
          from the Data Hub bot. In-app and Slack are independent — you can turn
          off in-app for a type and receive it only via Slack.
        </CardDescription>
      </CardHeader>
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

interface ConnectedProps {
  onSlackCommentsAttributedChange: (value: boolean) => void;
  onSlackCommentsParticipatedChange: (value: boolean) => void;
  onSlackRunsChange: (value: boolean) => void;
  revoked: boolean;
  slackCommentsAttributedEnabled: boolean;
  slackCommentsParticipatedEnabled: boolean;
  // Controlled switch values from the parent TanStack Form state.
  slackRunsEnabled: boolean;
  slackTeamName: string | null;
}

function Connected({
  slackTeamName,
  revoked,
  slackRunsEnabled,
  slackCommentsAttributedEnabled,
  slackCommentsParticipatedEnabled,
  onSlackRunsChange,
  onSlackCommentsAttributedChange,
  onSlackCommentsParticipatedChange,
}: ConnectedProps) {
  const router = useRouter();
  const [disconnecting, setDisconnecting] = useState(false);

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
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BotMessageSquare aria-hidden className="size-4 shrink-0" />
          Slack notifications
          {revoked ? (
            <Badge className="ml-auto" variant="destructive">
              Reconnect required
            </Badge>
          ) : (
            <Badge className="ml-auto" variant="secondary">
              Connected{slackTeamName ? ` · ${slackTeamName}` : ""}
            </Badge>
          )}
        </CardTitle>
        {revoked ? (
          <CardDescription className="flex items-start gap-1.5 text-destructive">
            <TriangleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            The Slack connection is no longer valid. Reconnect to resume DMs.
          </CardDescription>
        ) : (
          <CardDescription>
            Choose which notification types to also deliver as Slack DMs. In-app
            and Slack are independent — you can enable Slack only for a type by
            turning off its in-app switch above.
          </CardDescription>
        )}
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {revoked ? (
          <Button asChild variant="outline">
            <a href="/api/v1/settings/slack/connect">Reconnect to Slack</a>
          </Button>
        ) : (
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="slack-runs">
                  New instrument runs
                </FieldLabel>
                <FieldDescription>
                  DM me when a new run is reported on a subscribed instrument.
                </FieldDescription>
              </FieldContent>
              <Switch
                aria-label="Send new run notifications via Slack DM"
                checked={slackRunsEnabled}
                id="slack-runs"
                onCheckedChange={onSlackRunsChange}
              />
            </Field>

            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="slack-comments-attributed">
                  Comments on runs you ran
                </FieldLabel>
                <FieldDescription>
                  DM me when someone comments on a run I&apos;m attributed to.
                </FieldDescription>
              </FieldContent>
              <Switch
                aria-label="Send attributed comment notifications via Slack DM"
                checked={slackCommentsAttributedEnabled}
                id="slack-comments-attributed"
                onCheckedChange={onSlackCommentsAttributedChange}
              />
            </Field>

            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="slack-comments-participated">
                  Replies to your comments
                </FieldLabel>
                <FieldDescription>
                  DM me when someone comments on a run I&apos;ve previously
                  commented on.
                </FieldDescription>
              </FieldContent>
              <Switch
                aria-label="Send participated comment notifications via Slack DM"
                checked={slackCommentsParticipatedEnabled}
                id="slack-comments-participated"
                onCheckedChange={onSlackCommentsParticipatedChange}
              />
            </Field>
          </FieldGroup>
        )}

        <div className="border-t pt-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                disabled={disconnecting}
                onClick={handleDisconnect}
                size="sm"
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
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Public namespace — compound component pattern avoids boolean props.
// ---------------------------------------------------------------------------

export const SlackConnectionCard = {
  Connected,
  Disconnected,
};
