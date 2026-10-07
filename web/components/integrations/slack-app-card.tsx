"use client";

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { IntegrationField } from "@/components/integrations/integration-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import type { PlainFieldStatus } from "@/lib/integrations/field-status";
import type {
  SlackAppConfigForAdmin,
  SlackAppConfigPutBody,
} from "@/lib/slack/app-config";

type SlackField = keyof SlackAppConfigPutBody;
type SlackPatch = Partial<Record<SlackField, string | null>>;

type Props = Pick<
  SlackAppConfigForAdmin,
  "botToken" | "clientId" | "clientSecret" | "teamId"
>;

/**
 * Drafts live in state seeded from props, so the page renders this card with
 * a `key` that changes on every save. That remounts it with fresh drafts and
 * avoids copying props into state in an effect.
 */
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
  const [clearing, setClearing] = useState<SlackField | null>(null);

  async function put(body: SlackPatch) {
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

  function buildPatch(): SlackPatch {
    const body: SlackPatch = {};
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
    return body;
  }

  const patch = buildPatch();
  const dirty = Object.keys(patch).length > 0;

  async function handleSave() {
    if (!dirty) {
      return;
    }
    setSaving(true);
    try {
      await put(patch);
      toast.success("Slack app settings saved");
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't save Slack settings"
      );
    } finally {
      setSaving(false);
    }
  }

  async function clearSaved(field: SlackField) {
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
            <IntegrationField
              clearing={clearing === "bot_token"}
              description="Bot user token with the chat:write scope."
              envName="SLACK_BOT_TOKEN"
              id="slack-bot-token"
              label="Bot token"
              onChange={setBotTokenDraft}
              onClear={() => clearSaved("bot_token")}
              placeholder="xoxb-…"
              status={botToken}
              type="password"
              value={botTokenDraft}
            />
            <IntegrationField
              clearing={clearing === "client_id"}
              description="From the Slack app's Basic Information page."
              envName="SLACK_CLIENT_ID"
              id="slack-client-id"
              label="Client ID"
              onChange={setClientIdDraft}
              onClear={() => clearSaved("client_id")}
              status={clientId}
              type="text"
              value={clientIdDraft}
            />
            <IntegrationField
              clearing={clearing === "client_secret"}
              description="From the Slack app's Basic Information page."
              envName="SLACK_CLIENT_SECRET"
              id="slack-client-secret"
              label="Client secret"
              onChange={setClientSecretDraft}
              onClear={() => clearSaved("client_secret")}
              placeholder="Paste a client secret"
              status={clientSecret}
              type="password"
              value={clientSecretDraft}
            />
            <IntegrationField
              clearing={clearing === "team_id"}
              description="Optional. Limits Connect Slack to this workspace."
              envName="SLACK_TEAM_ID"
              id="slack-team-id"
              label="Allowed workspace ID"
              onChange={setTeamIdDraft}
              onClear={() => clearSaved("team_id")}
              status={teamId}
              type="text"
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

// Emptying a field that has a saved value clears it. Emptying a field that
// only has an environment value changes nothing.
function plainPatch(
  field: PlainFieldStatus,
  draft: string
): string | null | undefined {
  const trimmed = draft.trim();
  if (field.source === "database" && trimmed.length === 0) {
    return null;
  }
  if (trimmed === (field.value ?? "") || trimmed.length === 0) {
    return;
  }
  return trimmed;
}
