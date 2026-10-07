"use client";

import { Loader2 } from "lucide-react";
import { useState } from "react";
import {
  CopyValue,
  InLinearInstructions,
} from "@/components/integrations/linear/steps";
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

const LINEAR_API = "https://linear.app/settings/api";

export function ConnectStep() {
  const { connect, data } = useLinearSetup();
  const [clientId, setClientId] = useState(data.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<{ code: string; message: string } | null>(
    null
  );
  const [pendingWorkspace, setPendingWorkspace] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(true);
  const credentialsOff = error?.code === LINEAR_CLIENT_CREDENTIALS_OFF;

  async function submit(confirmWorkspaceChange = false) {
    setBusy(true);
    setError(null);
    const failure = await connect({
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
    <div className="flex flex-col gap-4">
      {stepsOpen ? (
        <InLinearInstructions href={LINEAR_API}>
          <li>
            Go to Settings → API → OAuth applications and create a new
            application.
          </li>
          <li>
            Name it Data Hub. Linear shows this name on every issue it files.
          </li>
          <li>
            Linear asks for a callback URL. Data Hub doesn't use one, so paste
            this:
            <CopyValue
              id="linear-callback-url"
              label="Callback URL"
              value={data.origin}
            />
          </li>
          <li>Turn on Client credentials.</li>
          <li>Save, then copy the client ID and client secret.</li>
        </InLinearInstructions>
      ) : (
        <Button
          className="w-fit"
          onClick={() => setStepsOpen(true)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Show the steps in Linear
        </Button>
      )}
      <div className="grid gap-2">
        <Label htmlFor="linear-client-id">Client ID</Label>
        <Input
          autoComplete="off"
          id="linear-client-id"
          onChange={(event) => setClientId(event.target.value)}
          placeholder="Paste the client ID"
          spellCheck={false}
          value={clientId}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="linear-client-secret">Client secret</Label>
        <Input
          autoComplete="off"
          id="linear-client-secret"
          onChange={(event) => setClientSecret(event.target.value)}
          placeholder="Paste the client secret"
          spellCheck={false}
          type="password"
          value={clientSecret}
        />
      </div>
      {credentialsOff ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-900 text-sm dark:border-red-900 dark:bg-red-950 dark:text-red-100">
          <p className="font-medium">Client credentials are off for this app</p>
          <p className="mt-1">
            Linear lets Data Hub sign in as the app only after you turn them on.
            In Linear, open the app, turn on Client credentials, and then choose
            Connect again.
          </p>
          <a
            className="mt-2 inline-flex text-sm underline underline-offset-2"
            href={LINEAR_API}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open the app in Linear
          </a>
        </div>
      ) : error ? (
        <p className="text-destructive text-sm" role="alert">
          {error.message}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={
            busy || clientId.trim() === "" || clientSecret.trim() === ""
          }
          onClick={() => void submit(false)}
          type="button"
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          Connect
        </Button>
        <p className="text-muted-foreground text-sm">
          Data Hub checks these with Linear before it saves them.
        </p>
      </div>
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
    </div>
  );
}
