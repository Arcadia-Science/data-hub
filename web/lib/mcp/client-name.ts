import type { AuthInfo } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { oauthClients } from "@/lib/db/schema";
import { getMcpUserId } from "@/lib/mcp/tools/helpers";

const CLIENT_NAME_MAX = 100;
const CACHE_MAX = 500;

// One lookup per OAuth client for the life of the instance. Names rarely
// change, and a miss would otherwise hit Postgres on every tool call.
const nameByClientId = new Map<string, string>();

function trimClientLabel(value: string): string {
  const trimmed = value.trim().slice(0, CLIENT_NAME_MAX);
  return trimmed.length > 0 ? trimmed : "unknown";
}

/** PAT fallback stores the user id in `clientId`, which is not a client name. */
export function isPatAuth(authInfo: AuthInfo | undefined): boolean {
  const userId = getMcpUserId(authInfo);
  return Boolean(authInfo && userId && authInfo.clientId === userId);
}

/**
 * Display name registered for the OAuth client ("Cursor", "Claude"), `pat`
 * for the personal-access-token fallback, or `unknown` when the row has no name.
 */
export async function mcpClientLabel(
  authInfo: AuthInfo | undefined
): Promise<string> {
  if (!authInfo?.clientId || authInfo.clientId === "unknown") {
    return "unknown";
  }
  if (isPatAuth(authInfo)) {
    return "pat";
  }

  const cached = nameByClientId.get(authInfo.clientId);
  if (cached) {
    return cached;
  }

  const [row] = await db
    .select({ name: oauthClients.name })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, authInfo.clientId))
    .limit(1);

  const label = trimClientLabel(row?.name ?? "unknown");
  nameByClientId.set(authInfo.clientId, label);
  if (nameByClientId.size > CACHE_MAX) {
    const oldest = nameByClientId.keys().next().value;
    if (oldest) {
      nameByClientId.delete(oldest);
    }
  }
  return label;
}
