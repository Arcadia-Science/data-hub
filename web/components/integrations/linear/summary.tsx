"use client";

import { Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
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
import { feedbackStatusFromLinearState } from "@/lib/linear/feedback-link";
import { useLinearSetup } from "./linear-setup-context";

const REPORTER_ROWS = [
  ["Done, or any other completed status", "completed"],
  ["Canceled", "canceled"],
  ["Duplicate", "duplicate"],
  ["Any other status", "started"],
] as const;

export function LinearSummary() {
  const { data, disconnect, goTo, saveSigningSecret } = useLinearSetup();
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const needsAttention = data.webhookRejections > 0;
  const labels = [
    data.labels.bug,
    data.labels.feature_request,
    data.labels.other,
  ]
    .flatMap((label) => (label ? [label.name] : []))
    .join(", ");

  return (
    <div className="divide-y">
      <SummaryRow
        action={
          <Button
            onClick={() => goTo("connect")}
            size="sm"
            type="button"
            variant="outline"
          >
            Replace credentials
          </Button>
        }
        label="Linear app"
      >
        <p>Connected to {data.workspaceName ?? "Linear"}</p>
        {data.clientId ? (
          <p className="font-mono text-muted-foreground text-xs">
            Client ID {data.clientId}
          </p>
        ) : null}
      </SummaryRow>
      <SummaryRow
        action={
          <Button
            onClick={() => goTo("destination")}
            size="sm"
            type="button"
            variant="outline"
          >
            Change
          </Button>
        }
        label="Reports go to"
      >
        <p>
          {data.team?.name ?? "No team"}
          {data.project ? `, ${data.project.name} project` : ""}
        </p>
        <p className="text-muted-foreground text-sm">
          {labels
            ? `Labeled ${labels}. Everyone can send feedback from the account menu.`
            : "Everyone can send feedback from the account menu."}
        </p>
      </SummaryRow>
      <SummaryRow
        action={
          needsAttention ? null : (
            <Button
              onClick={() => goTo("updates")}
              size="sm"
              type="button"
              variant="outline"
            >
              Change
            </Button>
          )
        }
        label="Status updates"
      >
        <StatusLine />
        {needsAttention ? (
          <div className="mt-3 flex flex-col gap-2">
            <p className="text-sm">
              Data Hub rejected Linear's last {data.webhookRejections}{" "}
              {data.webhookRejections === 1 ? "update" : "updates"}
              {data.rejectionReason === "signature"
                ? " because the signing secret doesn't match"
                : ""}
              . Reporters won't hear when their issues close until this is
              fixed. Linear may have turned the webhook off after repeated
              failures.
            </p>
            <Label htmlFor="linear-new-signing-secret">
              New signing secret
            </Label>
            <div className="flex gap-2">
              <Input
                autoComplete="off"
                id="linear-new-signing-secret"
                onChange={(event) => setSecret(event.target.value)}
                placeholder="Paste it from the webhook's page in Linear"
                spellCheck={false}
                type="password"
                value={secret}
              />
              <Button
                disabled={saving || secret.trim() === ""}
                onClick={() => {
                  setSaving(true);
                  setError(null);
                  saveSigningSecret(secret.trim())
                    .then(() => setSecret(""))
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
            </div>
            {error ? (
              <p className="text-destructive text-sm" role="alert">
                {error}
              </p>
            ) : null}
            <a
              className="text-sm underline underline-offset-2"
              href="https://linear.app/settings/api"
              rel="noopener noreferrer"
              target="_blank"
            >
              Open webhooks in Linear
            </a>
          </div>
        ) : null}
      </SummaryRow>
      <div className="grid gap-3 py-4 sm:grid-cols-[9rem_1fr]">
        <p className="font-medium text-sm">What reporters see</p>
        <div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 font-normal">When the issue moves to</th>
                <th className="py-1 font-normal">The reporter sees</th>
              </tr>
            </thead>
            <tbody>
              {REPORTER_ROWS.map(([label, type]) => (
                <tr key={type}>
                  <td className="py-1.5 pr-4">{label}</td>
                  <td className="py-1.5">
                    <FeedbackStatusBadge
                      status={feedbackStatusFromLinearState(type)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-muted-foreground text-sm">
            Data Hub notifies the reporter once, when the issue first closes.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="flex items-center gap-3">
          <Button
            onClick={() => setConfirmDisconnect(true)}
            type="button"
            variant="destructive"
          >
            Disconnect Linear
          </Button>
          {data.lastUpdatedAt ? (
            <p
              className="text-muted-foreground text-sm"
              suppressHydrationWarning
            >
              Last updated {formatUpdated(data.lastUpdatedAt)}
              {data.lastUpdatedBy ? ` by ${data.lastUpdatedBy}` : ""}.
            </p>
          ) : null}
        </div>
        <Button onClick={() => goTo("test")} type="button" variant="outline">
          Send test report
        </Button>
      </div>
      <AlertDialog onOpenChange={setConfirmDisconnect} open={confirmDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect Linear?</AlertDialogTitle>
            <AlertDialogDescription>
              Feedback turns off. Issues already in Linear stay there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void disconnect()}
              type="button"
              variant="destructive"
            >
              Disconnect
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function StatusLine() {
  const { data } = useLinearSetup();
  if (data.webhookRejections > 0) {
    return (
      <p>
        <span className="mr-1 inline-block size-2 rounded-full bg-red-500" />
        Not working
      </p>
    );
  }
  if (!data.webhookSecretSet) {
    return <p>Not set up</p>;
  }
  if (!data.lastWebhookAt) {
    return <p>Waiting for Linear's first update.</p>;
  }
  return (
    <p suppressHydrationWarning>
      <span className="mr-1 inline-block size-2 rounded-full bg-green-500" />
      Working. Last update {formatUpdated(data.lastWebhookAt)}.
    </p>
  );
}

function SummaryRow({
  action,
  children,
  label,
}: {
  action: ReactNode;
  children: ReactNode;
  label: string;
}) {
  return (
    <div className="grid items-start gap-3 py-4 sm:grid-cols-[9rem_1fr_auto]">
      <p className="font-medium text-sm">{label}</p>
      <div className="min-w-0 text-sm">{children}</div>
      <div>{action}</div>
    </div>
  );
}

function formatUpdated(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
