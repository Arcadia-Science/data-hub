import type { AuthInfo } from "@modelcontextprotocol/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { oauthClients } from "@/lib/db/schema";

const CLIENT_NAME_MAX = 100;
const CACHE_MAX = 500;

// One lookup per OAuth client for the life of the instance. Names rarely
// change, and a miss would otherwise hit Postgres on every tool call.
const nameByClientId = new Map<string, string>();

function trimClientLabel(value: string): string {
  const trimmed = value.trim().slice(0, CLIENT_NAME_MAX);
  return trimmed.length > 0 ? trimmed : "unknown";
}

/**
 * Display name registered for the OAuth client ("Cursor", "Claude"), or
 * `unknown` when the row has no name.
 */
export async function mcpClientLabel(
  authInfo: AuthInfo | undefined
): Promise<string> {
  if (!authInfo?.clientId || authInfo.clientId === "unknown") {
    return "unknown";
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
