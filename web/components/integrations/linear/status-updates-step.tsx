"use client";

import { CheckIcon, Loader2 } from "lucide-react";
import { useState } from "react";
import {
  CopyValue,
  InLinearInstructions,
} from "@/components/integrations/linear/steps";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLinearSetup, useVisibleInterval } from "./linear-setup-context";

const LINEAR_API = "https://linear.app/settings/api";

export function StatusUpdatesStep() {
  const { data, goTo, refresh, saveSigningSecret } = useLinearSetup();
  const [secret, setSecret] = useState("");
  const [replacing, setReplacing] = useState(!data.webhookSecretSet);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const teamName = data.team?.name ?? "the team from step 2";

  useVisibleInterval(
    data.webhookSecretSet && data.lastWebhookAt === null,
    3000,
    () => {
      void refresh();
    }
  );

  return (
    <div className="flex flex-col gap-4">
      <InLinearInstructions href={LINEAR_API}>
        <li>Go to Settings → API and choose New webhook.</li>
        <li>
          Paste this URL:
          <CopyValue
            id="linear-webhook-url"
            label="Webhook URL"
            value={data.webhookUrl}
          />
        </li>
        <li>
          For Team, choose {teamName}, the team from step 2. Under events, turn
          on Issues only.
        </li>
        <li>Save the webhook, then copy its signing secret.</li>
      </InLinearInstructions>
      {data.webhookSecretSet && !replacing ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm">
          <span className="inline-flex items-center gap-2">
            <CheckIcon aria-hidden="true" className="size-4 text-green-600" />
            Saved
          </span>
          <Button
            onClick={() => setReplacing(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Replace
          </Button>
        </div>
      ) : (
        <div className="grid gap-2">
          <Label htmlFor="linear-signing-secret">Signing secret</Label>
          <Input
            autoComplete="off"
            id="linear-signing-secret"
            onChange={(event) => setSecret(event.target.value)}
            placeholder="Paste the signing secret"
            spellCheck={false}
            type="password"
            value={secret}
          />
          <p className="text-muted-foreground text-sm">
            Data Hub uses it to check that updates really come from Linear.
          </p>
        </div>
      )}
      <p aria-live="polite" className="text-sm">
        {data.lastWebhookAt
          ? "Linear's first update has arrived."
          : "Waiting for the first update from Linear. Any change to an issue in this team sends one, including the test report in the next step."}
      </p>
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        {replacing || !data.webhookSecretSet ? (
          <Button
            disabled={saving || secret.trim() === ""}
            onClick={() => {
              setSaving(true);
              setError(null);
              saveSigningSecret(secret.trim())
                .then(() => {
                  setSecret("");
                  setReplacing(false);
                })
                .catch((err: unknown) => {
                  setError(
                    err instanceof Error ? err.message : "Couldn't save"
                  );
                })
                .finally(() => setSaving(false));
            }}
            type="button"
          >
            {saving ? <Loader2 className="animate-spin" /> : null}
            Save
          </Button>
        ) : null}
        <Button
          disabled={!data.webhookSecretSet}
          onClick={() => goTo("test")}
          type="button"
          variant={replacing || !data.webhookSecretSet ? "outline" : "default"}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
