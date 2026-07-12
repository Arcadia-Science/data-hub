// Resolves which user owns a newly minted PAT.
//
// Admins mint tokens for other members (MCP clients, watchers). The owner is
// the identity Bearer auth and write attribution (claim_run, comments, etc.)
// use — not necessarily the admin who clicked Create. Omitting `user_id`
// keeps the previous default: the minting admin owns the token (service
// accounts, watcher/Lambda keys).

export type ResolveTokenOwnerResult =
  | { ok: true; userId: string }
  | { ok: false; error: string };

export async function resolveTokenOwnerUserId(
  requestedUserId: unknown,
  callerUserId: string,
  userExists: (id: string) => Promise<boolean>
): Promise<ResolveTokenOwnerResult> {
  if (requestedUserId === undefined || requestedUserId === null) {
    return { ok: true, userId: callerUserId };
  }

  if (typeof requestedUserId !== "string" || !requestedUserId.trim()) {
    return { ok: false, error: "user_id must be a non-empty string" };
  }

  const userId = requestedUserId.trim();
  if (!(await userExists(userId))) {
    return { ok: false, error: "user_id does not match a known user" };
  }

  return { ok: true, userId };
}
