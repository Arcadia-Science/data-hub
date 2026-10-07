"use client";

import { ChevronRightIcon, CircleAlertIcon, Loader2 } from "lucide-react";
import { useState } from "react";
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
import { LINEAR_CLIENT_CREDENTIALS_OFF } from "@/lib/api/errors";
import { useLinearSetup } from "./linear-setup-context";
import { LINEAR_APPS_URL, LINEAR_NEW_APP_URL } from "./links";
import { CopyValue, ExternalLinkButton, InLinearInstructions } from "./steps";

const ERROR_ID = "linear-connect-error";
const INSTRUCTIONS_ID = "linear-connect-instructions";

export function ConnectStep() {
  const { actions, state } = useLinearSetup();
  const { data } = state;
  const [clientId, setClientId] = useState(data.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<{ code: string; message: string } | null>(
    null
  );
  const [pendingWorkspace, setPendingWorkspace] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(true);
  const credentialsOff = error?.code === LINEAR_CLIENT_CREDENTIALS_OFF;
  const canSubmit =
    !busy && clientId.trim() !== "" && clientSecret.trim() !== "";

  async function submit(confirmWorkspaceChange = false) {
    setBusy(true);
    setError(null);
    const failure = await actions.connect({
      clientId,
      clientSecret,
      confirmWorkspaceChange,
    });
    setBusy(false);
    if (!failure) {
      return;
    }
    if (failure.workspaceName && !confirmWorkspaceChange) {
      setPendingWorkspace(failure.workspaceName);
      return;
    }
    setError(failure);
    if (failure.code === LINEAR_CLIENT_CREDENTIALS_OFF) {
      setStepsOpen(false);
    }
  }

  return (
    <>
      <form
        className="flex flex-col gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) {
            void submit(false);
          }
        }}
      >
        {stepsOpen ? (
          <div id={INSTRUCTIONS_ID}>
            <InLinearInstructions href={LINEAR_NEW_APP_URL}>
              <li>
                Go to{" "}
                <strong className="font-semibold">
                  Settings → API → OAuth applications
                </strong>{" "}
                and create a new application.
              </li>
              <li>
                Name it <strong className="font-semibold">Data Hub</strong>.
                Linear shows this name on every issue it files.
              </li>
              <li>
                Linear asks for a callback URL. Data Hub doesn't use one, so
                paste this:
                <CopyValue label="Callback URL" value={data.origin} />
              </li>
              <li>
                Turn on{" "}
                <strong className="font-semibold">Client credentials</strong>.
              </li>
              <li>
                Save, then copy the{" "}
                <strong className="font-semibold">client ID</strong> and{" "}
                <strong className="font-semibold">client secret</strong>.
              </li>
            </InLinearInstructions>
          </div>
        ) : (
          <Button
            aria-controls={INSTRUCTIONS_ID}
            aria-expanded={false}
            className="w-fit"
            onClick={() => setStepsOpen(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ChevronRightIcon aria-hidden="true" />
            Show the steps in Linear
          </Button>
        )}
        <div className="grid gap-2">
          <Label htmlFor="linear-client-id">Client ID</Label>
          <Input
            aria-describedby={error ? ERROR_ID : undefined}
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            className="font-mono"
            id="linear-client-id"
            name="client_id"
            onChange={(event) => setClientId(event.target.value)}
            placeholder="Paste the client ID…"
            spellCheck={false}
            value={clientId}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="linear-client-secret">Client secret</Label>
          <Input
            aria-describedby={error ? ERROR_ID : undefined}
            aria-invalid={error ? true : undefined}
            autoComplete="off"
            className="font-mono"
            id="linear-client-secret"
            name="client_secret"
            onChange={(event) => setClientSecret(event.target.value)}
            placeholder="Paste the client secret…"
            spellCheck={false}
            type="password"
            value={clientSecret}
          />
        </div>
        {credentialsOff ? (
          <div
            className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-2.5 rounded-lg border border-red-200 bg-red-50 p-3 text-red-950 text-sm dark:border-red-900 dark:bg-red-950 dark:text-red-100"
            id={ERROR_ID}
            role="alert"
          >
            <CircleAlertIcon
              aria-hidden="true"
              className="mt-0.5 size-5 text-red-600 dark:text-red-400"
            />
            <div className="flex min-w-0 flex-col gap-1">
              <p className="font-semibold">
                Client credentials are off for this app
              </p>
              <p className="text-pretty">
                Linear lets Data Hub sign in as the app only after you turn them
                on. In Linear, open the app, turn on Client credentials, and
                then choose Connect again.
              </p>
              <div className="mt-2">
                <ExternalLinkButton href={LINEAR_APPS_URL}>
                  Open the app in Linear
                </ExternalLinkButton>
              </div>
            </div>
          </div>
        ) : error ? (
          <p className="text-destructive text-sm" id={ERROR_ID} role="alert">
            {error.message}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!canSubmit} type="submit">
            {busy ? (
              <Loader2
                aria-hidden="true"
                className="animate-spin motion-reduce:animate-none"
              />
            ) : null}
            {busy ? "Connecting…" : "Connect"}
          </Button>
          <p className="text-muted-foreground text-sm">
            Data Hub checks these with Linear before it saves them.
          </p>
        </div>
      </form>
      <AlertDialog
        onOpenChange={(open) => {
          if (!open) {
            setPendingWorkspace(null);
          }
        }}
        open={pendingWorkspace !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Connect to {pendingWorkspace}?</AlertDialogTitle>
            <AlertDialogDescription>
              These credentials belong to a different Linear workspace.
              Connecting clears the team, project, labels, and signing secret.
              Issues already in Linear stay there.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void submit(true)} type="button">
              Connect and clear setup
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
