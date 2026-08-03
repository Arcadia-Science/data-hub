"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient, useSession } from "@/lib/auth-client";

const SCOPE_LABELS: Record<string, string> = {
  openid: "Verify your identity",
  profile: "View your name and profile photo",
  email: "View your email address",
  offline_access: "Stay connected when you're offline",
  read: "Read instrument runs and files",
  write: "Claim runs, comment, and update data on your behalf",
};

function scopeLabel(scope: string) {
  return SCOPE_LABELS[scope] ?? scope;
}

function clientHost(clientId: string): string | null {
  try {
    return new URL(clientId).host || null;
  } catch {
    return null;
  }
}

/** Better Auth's public-client endpoint returns RFC 7591 field names. */
function clientNameFromPublicClient(data: unknown): string | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (typeof record.client_name === "string" && record.client_name) {
    return record.client_name;
  }
  // Defensive: some Better Auth helpers use camelCase in other endpoints.
  if (typeof record.name === "string" && record.name) {
    return record.name;
  }
  return null;
}

function ConsentContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, isPending: sessionPending } = useSession();
  const clientId = searchParams.get("client_id") ?? "";
  const scopeParam = searchParams.get("scope") ?? "";
  const scopes = useMemo(
    () => scopeParam.split(/\s+/).filter(Boolean),
    [scopeParam]
  );
  const host = useMemo(() => clientHost(clientId), [clientId]);

  const [clientName, setClientName] = useState<string>("MCP client");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (sessionPending) {
      return;
    }
    if (!session) {
      const qs = searchParams.toString();
      router.replace(qs ? `/login?${qs}` : "/login");
    }
  }, [session, sessionPending, router, searchParams]);

  useEffect(() => {
    if (!clientId) {
      return;
    }
    void authClient.oauth2
      .publicClient({ query: { client_id: clientId } })
      .then(({ data }) => {
        const name = clientNameFromPublicClient(data);
        if (name) {
          setClientName(name);
        }
      })
      .catch(() => {
        /* keep MCP client fallback */
      });
  }, [clientId]);

  async function decide(accept: boolean) {
    setBusy(true);
    setError(null);
    try {
      const { data, error: consentError } = await authClient.oauth2.consent({
        accept,
        scope: scopes.join(" "),
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
        {host ? (
          <p className="text-muted-foreground text-xs">
            From <span className="font-mono text-foreground/80">{host}</span>
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

export default function ConsentPage() {
  return (
    <div className="flex h-screen w-full items-center justify-center p-6">
      <Suspense fallback={<p className="text-muted-foreground">Loading…</p>}>
        <ConsentContent />
      </Suspense>
    </div>
  );
}
