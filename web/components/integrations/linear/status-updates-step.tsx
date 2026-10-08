"use client";

import { CheckIcon, Loader2 } from "lucide-react";
import { useState } from "react";
import { SecretInput } from "@/components/integrations/secret-input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { formatDateTimeShort } from "@/lib/date";
import { useLinearSetup, useVisibleInterval } from "./linear-setup-context";
import { LINEAR_WEBHOOKS_URL } from "./links";
import { CopyValue, InLinearInstructions } from "./steps";
import { useSigningSecretForm } from "./use-signing-secret-form";

export function StatusUpdatesStep() {
  const { actions, state } = useLinearSetup();
  const { data } = state;
  const [replacing, setReplacing] = useState(!data.webhookSecretSet);
  const form = useSigningSecretForm(() => setReplacing(false));
  const teamName = data.team?.name ?? "the team from step 2";
  const waiting = data.webhookSecretSet && data.lastWebhookAt === null;

  useVisibleInterval(waiting, 3000, () => {
    void actions.refresh();
  });

  return (
    <>
      <InLinearInstructions href={LINEAR_WEBHOOKS_URL}>
        <li>
          Go to <strong className="font-semibold">Settings → API</strong> and
          choose <strong className="font-semibold">New webhook</strong>.
        </li>
        <li>
          Paste this URL:
          <CopyValue label="Webhook URL" value={data.webhookUrl} />
        </li>
        <li>
          For <strong className="font-semibold">Team</strong>, choose{" "}
          <strong className="font-semibold">{teamName}</strong>, the team from
          step 2. Under events, turn on{" "}
          <strong className="font-semibold">Issues</strong> only.
        </li>
        <li>
          Save the webhook, then copy its{" "}
          <strong className="font-semibold">signing secret</strong>.
        </li>
      </InLinearInstructions>
      {data.webhookSecretSet && !replacing ? (
        <div className="flex flex-col gap-2">
          <p className="font-medium text-sm">Signing secret</p>
          <div className="flex items-center justify-between gap-3 rounded-lg border py-1.5 pr-1.5 pl-3 text-sm">
            <span className="inline-flex items-center gap-2">
              <CheckIcon
                aria-hidden="true"
                className="size-4 text-green-600 dark:text-green-400"
              />
              Saved
            </span>
            <Button
              onClick={() => setReplacing(true)}
              size="sm"
              type="button"
              variant="ghost"
            >
              Replace
              <span className="sr-only"> signing secret</span>
            </Button>
          </div>
          <p className="text-pretty text-muted-foreground text-sm">
            Data Hub uses it to check that updates really come from Linear.
          </p>
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void form.save();
          }}
        >
          <Label htmlFor="linear-signing-secret">Signing secret</Label>
          <SecretInput
            id="linear-signing-secret"
            name="signing_secret"
            onChange={(event) => form.setSecret(event.target.value)}
            placeholder="Paste the signing secret…"
            value={form.secret}
          />
          <p className="text-pretty text-muted-foreground text-sm">
            Data Hub uses it to check that updates really come from Linear.
          </p>
          {form.error ? (
            <p className="text-destructive text-sm" role="alert">
              {form.error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button disabled={!form.canSave} type="submit">
              {form.saving ? (
                <Loader2
                  aria-hidden="true"
                  className="animate-spin motion-reduce:animate-none"
                />
              ) : null}
              {form.saving ? "Saving…" : "Save"}
            </Button>
            {data.webhookSecretSet ? (
              <Button
                onClick={() => setReplacing(false)}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
            ) : null}
          </div>
        </form>
      )}
      <div
        className="rounded-lg bg-muted/60 p-3 text-sm empty:hidden"
        role="status"
      >
        {data.webhookSecretSet ? (
          <UpdateStatus lastWebhookAt={data.lastWebhookAt} team={teamName} />
        ) : null}
      </div>
      <div>
        <Button
          disabled={!data.webhookSecretSet}
          onClick={() => actions.goTo("test")}
          type="button"
          variant={replacing ? "outline" : "default"}
        >
          Continue
        </Button>
      </div>
    </>
  );
}

function UpdateStatus({
  lastWebhookAt,
  team,
}: {
  lastWebhookAt: string | null;
  team: string;
}) {
  if (lastWebhookAt) {
    return (
      <p className="inline-flex items-center gap-2 font-semibold">
        <CheckIcon
          aria-hidden="true"
          className="size-4 text-green-600 dark:text-green-400"
        />
        Linear's last update arrived{" "}
        {formatDateTimeShort(new Date(lastWebhookAt))}.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2.5">
      <Loader2
        aria-hidden="true"
        className="mt-0.5 size-5 animate-spin text-muted-foreground motion-reduce:animate-none"
      />
      <div className="flex flex-col gap-1">
        <p className="font-semibold">Waiting for an update from Linear</p>
        <p className="text-muted-foreground">
          Any change to an issue in {team} sends one, including the test report
          in the next step.
        </p>
      </div>
    </div>
  );
}
