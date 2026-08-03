"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient, useSession } from "@/lib/auth-client";

const SCOPE_LABELS: Record<string, string> = {
  openid: "Verify your identity",
  profile: "View your name and profile photo",
  email: "View your email address",
  offline_access: "Stay connected when you're offline",
  read: "Read instrument runs and files",
  write:
    "Claim runs, comment, delete runs, dismiss files, and reprocess data on your behalf",
};

function scopeLabel(scope: string) {
  return SCOPE_LABELS[scope] ?? scope;
}

export interface ConsentFormProps {
  clientId: string;
  /** Untrusted display name from dynamic client registration. */
  clientName: string;
  /** Full query string from the authorize → consent redirect (includes sig). */
  oauthQuery: string;
  /** Hosts from registered redirect_uris — the real destination of the grant. */
  redirectHosts: string[];
  scopes: string[];
}

export function ConsentForm({
  clientId,
  clientName,
  oauthQuery,
  redirectHosts,
  scopes,
}: ConsentFormProps) {
  const router = useRouter();
  const { data: session, isPending: sessionPending } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionPending) {
      return;
    }
    if (!session) {
      router.replace(oauthQuery ? `/login?${oauthQuery}` : "/login");
    }
  }, [session, sessionPending, router, oauthQuery]);

  async function decide(accept: boolean) {
    setBusy(true);
    setError(null);
    try {
      const { data, error: consentError } = await authClient.oauth2.consent({
        accept,
        scope: scopes.join(" "),
        // Resume the signed authorize params even if the client plugin
        // didn't attach them (e.g. after a full page load of /consent).
        oauth_query: oauthQuery,
      });
      if (consentError) {
        setError(consentError.message ?? "Consent failed");
        setBusy(false);
        return;
      }

      // Better Auth returns `{ redirect: true, url }` for browser fetch;
      // navigate explicitly so the authorize code reaches the MCP client.
      const redirectUrl =
        data &&
        typeof data === "object" &&
        "url" in data &&
        typeof (data as { url?: unknown }).url === "string"
          ? (data as { url: string }).url
          : data &&
              typeof data === "object" &&
              "redirect_uri" in data &&
              typeof (data as { redirect_uri?: unknown }).redirect_uri ===
                "string"
            ? (data as { redirect_uri: string }).redirect_uri
            : null;

      if (redirectUrl) {
        window.location.href = redirectUrl;
        return;
      }

      setError("Consent succeeded but no redirect URL was returned.");
      setBusy(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Consent failed");
      setBusy(false);
    }
  }

  if (sessionPending || !session) {
    return <p className="text-muted-foreground">Checking session…</p>;
  }

  if (!clientId) {
    return (
      <p className="text-muted-foreground">
        Missing client_id. Start authorization from your MCP client.
      </p>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-6">
      <div className="flex flex-col gap-2 text-center">
        <h1 className="font-semibold text-2xl tracking-tight">
          Authorize application
        </h1>
        <p className="text-muted-foreground text-sm">
          <span className="font-medium text-foreground">{clientName}</span>{" "}
          wants access to Data Hub on your behalf.
        </p>
        {redirectHosts.length > 0 ? (
          <p className="text-muted-foreground text-xs">
            Redirects to{" "}
            <span className="font-mono text-foreground/80">
              {redirectHosts.join(", ")}
            </span>
          </p>
        ) : null}
      </div>

      {scopes.length > 0 ? (
        <ul className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">
          {scopes.map((scope) => (
            <li className="py-1" key={scope}>
              <span>{scopeLabel(scope)}</span>
              <span className="ml-2 font-mono text-muted-foreground text-xs">
                {scope}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {error ? (
        <p className="text-center text-destructive text-sm">{error}</p>
      ) : null}

      <div className="flex gap-3">
        <Button
          className="flex-1"
          disabled={busy}
          onClick={() => void decide(false)}
          variant="outline"
        >
          Deny
        </Button>
        <Button
          className="flex-1"
          disabled={busy}
          onClick={() => void decide(true)}
        >
          Allow
        </Button>
      </div>
    </div>
  );
}
