"use client";

import { ExternalLinkIcon, Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { RelativeTime } from "@/components/dashboard/relative-time";
import { FeedbackStatusBadge } from "@/components/feedback/feedback-badges";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDateTimeShort } from "@/lib/date";
import { feedbackStatusFromLinearState } from "@/lib/linear/feedback-link";
import { useLinearSetup } from "./linear-setup-context";
import { LINEAR_WEBHOOKS_URL } from "./links";
import { useSigningSecretForm } from "./use-signing-secret-form";

const REPORTER_ROWS = [
  ["Done, or any other completed status", "completed"],
  ["Canceled", "canceled"],
  ["Duplicate", "duplicate"],
  ["Any other status", "started"],
] as const;

// "A", "A or B", "A, B, or C".
function listWithOr(names: string[]): string {
  if (names.length <= 2) {
    return names.join(" or ");
  }
  return `${names.slice(0, -1).join(", ")}, or ${names.at(-1)}`;
}

export function LinearSummary() {
  const { actions, state } = useLinearSetup();
  const { data } = state;
  const needsAttention = data.webhookRejections > 0;
  const labelNames = [
    data.labels.bug,
    data.labels.feature_request,
    data.labels.other,
  ].flatMap((label) => (label ? [label.name] : []));

  return (
    <div>
      <dl className="divide-y">
        <SummaryRow
          action={
            <Button
              onClick={() => actions.goTo("connect")}
              size="sm"
              type="button"
              variant="outline"
            >
              Replace credentials
            </Button>
          }
          label="Linear app"
        >
          <span>Connected to {data.workspaceName ?? "Linear"}</span>
          {data.clientId ? (
            <span
              className="break-all font-mono text-[13px] text-muted-foreground"
              translate="no"
            >
              Client ID {data.clientId}
            </span>
          ) : null}
        </SummaryRow>
        <SummaryRow
          action={
            <Button
              onClick={() => actions.goTo("destination")}
              size="sm"
              type="button"
              variant="outline"
            >
              Change
              <span className="sr-only"> where reports go</span>
            </Button>
          }
          label="Reports go to"
        >
          <span>
            {data.team?.name ?? "No team"} team
            {data.project ? `, ${data.project.name} project` : ""}
          </span>
          <span className="text-pretty text-muted-foreground">
            {labelNames.length > 0 ? `Labeled ${listWithOr(labelNames)}. ` : ""}
            Everyone can send feedback from the account menu.
          </span>
        </SummaryRow>
        <StatusRow needsAttention={needsAttention} />
        <div className="grid items-start gap-4 px-6 py-[18px] sm:grid-cols-[9.375rem_minmax(0,1fr)]">
          <dt className="pt-1.5 font-medium">What reporters see</dt>
          <dd>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pr-3 pb-2 font-medium" scope="col">
                    When the issue moves to
                  </th>
                  <th className="pb-2 font-medium" scope="col">
                    The reporter sees
                  </th>
                </tr>
              </thead>
              <tbody>
                {REPORTER_ROWS.map(([label, type]) => (
                  <tr className="border-t" key={type}>
                    <td className="py-2 pr-3 align-top">{label}</td>
                    <td className="py-2 align-top">
                      <FeedbackStatusBadge
                        status={feedbackStatusFromLinearState(type)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-muted-foreground">
              Data Hub notifies the reporter once, when the issue first closes.
            </p>
          </dd>
        </div>
      </dl>
      <SummaryFooter />
    </div>
  );
}

// `live` makes the row's text a live region, so a change such as "Waiting"
// becoming "Working" is announced.
function SummaryRow({
  action,
  children,
  label,
  live = false,
}: {
  action: ReactNode;
  children: ReactNode;
  label: string;
  live?: boolean;
}) {
  return (
    <div className="grid items-start gap-x-4 gap-y-1 px-6 py-[18px] sm:grid-cols-[9.375rem_minmax(0,1fr)_auto]">
      <dt className="pt-1.5 font-medium">{label}</dt>
      <dd
        aria-live={live ? "polite" : undefined}
        className="flex min-w-0 flex-col gap-0.5 pt-1.5"
      >
        {children}
      </dd>
      <dd>{action}</dd>
    </div>
  );
}

function StatusRow({ needsAttention }: { needsAttention: boolean }) {
  const { actions, state } = useLinearSetup();
  const { data } = state;
  const form = useSigningSecretForm();

  if (needsAttention) {
    return (
      <div className="grid items-start gap-x-4 gap-y-1 px-6 py-[18px] sm:grid-cols-[9.375rem_minmax(0,1fr)]">
        <dt className="pt-1.5 font-medium">Status updates</dt>
        <dd aria-live="polite" className="flex min-w-0 flex-col gap-3 pt-1.5">
          <StatusLine tone="bad">Not working</StatusLine>
          <p className="text-pretty text-neutral-700 dark:text-neutral-300">
            Data Hub rejected Linear's last {data.webhookRejections}{" "}
            {data.webhookRejections === 1 ? "update" : "updates"}
            {data.rejectionReason === "signature"
              ? " because the signing secret doesn't match"
              : ""}
            . Reporters won't hear when their issues close until this is fixed.
            Linear may have turned the webhook off after repeated failures.
          </p>
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void form.save();
            }}
          >
            <Label htmlFor="linear-new-signing-secret">
              New signing secret
            </Label>
            <div className="flex gap-2">
              <Input
                autoComplete="off"
                id="linear-new-signing-secret"
                name="signing_secret"
                onChange={(event) => form.setSecret(event.target.value)}
                placeholder="Paste it from the webhook's page in Linear…"
                spellCheck={false}
                type="password"
                value={form.secret}
              />
              <Button disabled={!form.canSave} type="submit">
                {form.saving ? (
                  <Loader2
                    aria-hidden="true"
                    className="animate-spin motion-reduce:animate-none"
                  />
                ) : null}
                {form.saving ? "Saving…" : "Save"}
              </Button>
            </div>
            {form.error ? (
              <p className="text-destructive text-sm" role="alert">
                {form.error}
              </p>
            ) : null}
          </form>
          <a
            className="inline-flex items-center gap-1 self-start font-medium underline underline-offset-2 hover:text-muted-foreground"
            href={LINEAR_WEBHOOKS_URL}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open webhooks in Linear
            <ExternalLinkIcon aria-hidden="true" className="size-3.5" />
          </a>
        </dd>
      </div>
    );
  }

  return (
    <SummaryRow
      action={
        <Button
          onClick={() => actions.goTo("updates")}
          size="sm"
          type="button"
          variant="outline"
        >
          Change
          <span className="sr-only"> status updates</span>
        </Button>
      }
      label="Status updates"
      live
    >
      {data.webhookSecretSet ? (
        data.lastWebhookAt ? (
          <>
            <StatusLine tone="good">Working</StatusLine>
            <span className="text-muted-foreground">
              Last update from Linear{" "}
              {formatDateTimeShort(new Date(data.lastWebhookAt))}.
            </span>
          </>
        ) : (
          <span>Waiting for Linear's first update.</span>
        )
      ) : (
        <span>Not set up</span>
      )}
    </SummaryRow>
  );
}

function StatusLine({
  children,
  tone,
}: {
  children: string;
  tone: "bad" | "good";
}) {
  return (
    <span
      className="inline-flex items-center gap-2 font-medium"
      role={tone === "bad" ? "alert" : undefined}
    >
      <span
        aria-hidden="true"
        className={`size-2 rounded-full ${tone === "bad" ? "bg-red-600" : "bg-green-600"}`}
      />
      {children}
    </span>
  );
}

function SummaryFooter() {
  const { actions, state } = useLinearSetup();
  const { data } = state;
  const [confirming, setConfirming] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function disconnect() {
    setDisconnecting(true);
    setError(null);
    try {
      await actions.disconnect();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't disconnect");
      setDisconnecting(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t px-6 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => setConfirming(true)}
          size="sm"
          type="button"
          variant="destructive"
        >
          Disconnect Linear
        </Button>
        {data.lastUpdatedAt ? (
          <p className="text-muted-foreground text-sm">
            Last updated <RelativeTime date={data.lastUpdatedAt} />
            {data.lastUpdatedBy ? (
              <>
                {" "}
                by <span className="text-foreground">{data.lastUpdatedBy}</span>
              </>
            ) : null}
            .
          </p>
        ) : null}
      </div>
      <Button
        onClick={() => actions.goTo("test")}
        size="sm"
        type="button"
        variant="outline"
      >
        Send test report
      </Button>
      <AlertDialog
        onOpenChange={(open) => {
          if (!disconnecting) {
            setConfirming(open);
            setError(null);
          }
        }}
        open={confirming}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Linear?</AlertDialogTitle>
            <AlertDialogDescription>
              Feedback turns off. Issues already in Linear stay there.
            </AlertDialogDescription>
            {error ? (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={disconnecting} type="button">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={disconnecting}
              onClick={(event) => {
                // Keeps the dialog open until the request finishes, so a
                // failure shows here and not nowhere.
                event.preventDefault();
                void disconnect();
              }}
              type="button"
              variant="destructive"
            >
              {disconnecting ? "Disconnecting…" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
