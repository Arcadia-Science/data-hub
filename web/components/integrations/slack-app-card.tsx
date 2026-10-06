"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { SlackAppConfigSource } from "@/lib/slack/app-config";

interface SecretField {
  set: boolean;
  source: SlackAppConfigSource | null;
}

interface PlainField extends SecretField {
  value: string | null;
}

interface Props {
  botToken: SecretField;
  clientId: PlainField;
  clientSecret: SecretField;
  teamId: PlainField;
}

function sourceText(
  source: SlackAppConfigSource | null,
  envName: string
): string {
  if (source === "database") {
    return "Saved here";
  }
  if (source === "environment") {
    return `Using ${envName}`;
  }
  return "Not set";
}

function SourceBadge({
  source,
  envName,
}: {
  source: SlackAppConfigSource | null;
  envName: string;
}) {
  return <Badge variant="secondary">{sourceText(source, envName)}</Badge>;
}

export function SlackAppCard({
  botToken,
  clientId,
  clientSecret,
  teamId,
}: Props) {
  const router = useRouter();
  const [botTokenDraft, setBotTokenDraft] = useState("");
  const [clientSecretDraft, setClientSecretDraft] = useState("");
  const [clientIdDraft, setClientIdDraft] = useState(clientId.value ?? "");
  const [teamIdDraft, setTeamIdDraft] = useState(teamId.value ?? "");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState<string | null>(null);

  useEffect(() => {
    setClientIdDraft(clientId.value ?? "");
    setTeamIdDraft(teamId.value ?? "");
  }, [clientId.value, teamId.value]);

  async function put(body: Record<string, string | null>) {
    const res = await fetch("/api/v1/settings/integrations/slack", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const payload = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      throw new Error(
        payload?.error?.message ?? "Couldn't save Slack settings"
      );
    }
  }

  async function handleSave() {
    const body: Record<string, string | null> = {};
    const bot = botTokenDraft.trim();
    if (bot) {
      body.bot_token = bot;
    }
    const secret = clientSecretDraft.trim();
    if (secret) {
      body.client_secret = secret;
    }
    const nextClientId = plainPatch(clientId, clientIdDraft);
    if (nextClientId !== undefined) {
      body.client_id = nextClientId;
    }
    const nextTeamId = plainPatch(teamId, teamIdDraft);
    if (nextTeamId !== undefined) {
      body.team_id = nextTeamId;
    }
    if (Object.keys(body).length === 0) {
      return;
    }

    setSaving(true);
    try {
      await put(body);
      toast.success("Slack app settings saved");
      setBotTokenDraft("");
      setClientSecretDraft("");
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't save Slack settings"
      );
    } finally {
      setSaving(false);
    }
  }

  async function clearSaved(field: string) {
    setClearing(field);
    try {
      await put({ [field]: null });
      toast.success("Saved Slack value removed");
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't remove the saved value"
      );
    } finally {
      setClearing(null);
    }
  }

  const dirty =
    botTokenDraft.trim().length > 0 ||
    clientSecretDraft.trim().length > 0 ||
    plainPatch(clientId, clientIdDraft) !== undefined ||
    plainPatch(teamId, teamIdDraft) !== undefined;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-semibold text-lg tracking-tight">Slack app</h2>
        <p className="text-muted-foreground text-sm">
          Credentials for direct messages and Connect Slack. A value saved here
          is used instead of the environment variable. Removing it makes that
          variable the source again.
        </p>
      </div>
      <Card>
        <CardContent className="flex flex-col gap-6">
          <FieldGroup>
            <SecretInput
              clearing={clearing === "bot_token"}
              description="Bot user token with the chat:write scope."
              envName="SLACK_BOT_TOKEN"
              id="slack-bot-token"
              label="Bot token"
              onChange={setBotTokenDraft}
              onClear={
                botToken.source === "database"
                  ? () => clearSaved("bot_token")
                  : null
              }
              placeholder="xoxb-…"
              status={botToken}
              value={botTokenDraft}
            />
            <PlainInput
              clearing={clearing === "client_id"}
              description="From the Slack app's Basic Information page."
              envName="SLACK_CLIENT_ID"
              id="slack-client-id"
              label="Client ID"
              onChange={setClientIdDraft}
              onClear={
                clientId.source === "database"
                  ? () => clearSaved("client_id")
                  : null
              }
              status={clientId}
              value={clientIdDraft}
            />
            <SecretInput
              clearing={clearing === "client_secret"}
              description="From the Slack app's Basic Information page."
              envName="SLACK_CLIENT_SECRET"
              id="slack-client-secret"
              label="Client secret"
              onChange={setClientSecretDraft}
              onClear={
                clientSecret.source === "database"
                  ? () => clearSaved("client_secret")
                  : null
              }
              placeholder="Paste a client secret"
              status={clientSecret}
              value={clientSecretDraft}
            />
            <PlainInput
              clearing={clearing === "team_id"}
              description="Optional. Limits Connect Slack to this workspace."
              envName="SLACK_TEAM_ID"
              id="slack-team-id"
              label="Allowed workspace ID"
              onChange={setTeamIdDraft}
              onClear={
                teamId.source === "database"
                  ? () => clearSaved("team_id")
                  : null
              }
              status={teamId}
              value={teamIdDraft}
            />
          </FieldGroup>
          <div className="flex justify-end border-t pt-4">
            <Button
              disabled={!dirty || saving}
              onClick={handleSave}
              type="button"
            >
              {saving ? (
                <Loader2 className="animate-spin" data-icon="inline-start" />
              ) : null}
              Save
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function plainPatch(
  field: PlainField,
  draft: string
): string | null | undefined {
  const trimmed = draft.trim();
  if (field.source === "database" && trimmed.length === 0) {
    return null;
  }
  if (trimmed === (field.value ?? "")) {
    return;
  }
  if (trimmed.length === 0) {
    return;
  }
  return trimmed;
}

function SecretInput({
  clearing,
  description,
  envName,
  id,
  label,
  onChange,
  onClear,
  placeholder,
  status,
  value,
}: {
  clearing: boolean;
  description: string;
  envName: string;
  id: string;
  label: string;
  onChange: (value: string) => void;
  onClear: (() => void) | null;
  placeholder: string;
  status: SecretField;
  value: string;
}) {
  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <SourceBadge envName={envName} source={status.source} />
      </div>
      <Input
        autoComplete="off"
        className="font-mono"
        id={id}
        onChange={(event) => onChange(event.target.value)}
        placeholder={
          status.set ? "Paste a new value to replace it" : placeholder
        }
        spellCheck={false}
        type="password"
        value={value}
      />
      <FieldDescription>{description}</FieldDescription>
      {onClear ? (
        <Button
          disabled={clearing}
          onClick={onClear}
          size="sm"
          type="button"
          variant="outline"
        >
          {clearing ? (
            <Loader2 className="animate-spin" data-icon="inline-start" />
          ) : null}
          Remove saved value
        </Button>
      ) : null}
    </Field>
  );
}

function PlainInput({
  clearing,
  description,
  envName,
  id,
  label,
  onChange,
  onClear,
  status,
  value,
}: {
  clearing: boolean;
  description: string;
  envName: string;
  id: string;
  label: string;
  onChange: (value: string) => void;
  onClear: (() => void) | null;
  status: PlainField;
  value: string;
}) {
  return (
    <Field>
      <div className="flex items-center justify-between gap-2">
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <SourceBadge envName={envName} source={status.source} />
      </div>
      <Input
        autoComplete="off"
        className="font-mono"
        id={id}
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        value={value}
      />
      <FieldDescription>{description}</FieldDescription>
      {onClear ? (
        <Button
          disabled={clearing}
          onClick={onClear}
          size="sm"
          type="button"
          variant="outline"
        >
          {clearing ? (
            <Loader2 className="animate-spin" data-icon="inline-start" />
          ) : null}
          Remove saved value
        </Button>
      ) : null}
    </Field>
  );
}
