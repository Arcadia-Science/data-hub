import { eq } from "drizzle-orm";
import { ConsentForm } from "@/components/auth/consent-form";
import { db } from "@/lib/db";
import { oauthClients } from "@/lib/db/schema";

function redirectHostsFromUris(uris: string[] | null | undefined): string[] {
  if (!uris?.length) {
    return [];
  }
  const hosts = new Set<string>();
  for (const uri of uris) {
    try {
      const host = new URL(uri).host;
      if (host) {
        hosts.add(host);
      }
    } catch {
      // Ignore malformed redirect URIs; registration should have rejected them.
    }
  }
  return [...hosts];
}

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const clientId = typeof params.client_id === "string" ? params.client_id : "";
  const scopeParam = typeof params.scope === "string" ? params.scope : "";
  const scopes = scopeParam.split(/\s+/).filter(Boolean);

  // Preserve the full signed authorize query so consent / login resume works.
  const oauthQueryParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      oauthQueryParams.set(key, value);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        oauthQueryParams.append(key, entry);
      }
    }
  }
  const oauthQuery = oauthQueryParams.toString();

  let clientName = "MCP client";
  let redirectHosts: string[] = [];

  if (clientId) {
    // Read redirect_uris from the DB — `/oauth2/public-client` intentionally
    // omits them, and dynamically registered `client_name` is attacker-chosen.
    const [client] = await db
      .select({
        name: oauthClients.name,
        redirectUris: oauthClients.redirectUris,
      })
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);
    if (client?.name) {
      clientName = client.name;
    }
    redirectHosts = redirectHostsFromUris(client?.redirectUris);
  }

  return (
    <div className="flex h-screen w-full items-center justify-center p-6">
      <ConsentForm
        clientId={clientId}
        clientName={clientName}
        oauthQuery={oauthQuery}
        redirectHosts={redirectHosts}
        scopes={scopes}
      />
    </div>
  );
}
