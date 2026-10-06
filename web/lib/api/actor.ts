import { toUserAvatarUser, type UserAvatarUser } from "@/lib/avatar-color";

// Who performed an audited action (retiring an instrument, deregistering a
// watcher, posting a comment). Aliases `UserAvatarUser` so it feeds
// `<UserAvatar>` directly.
export type ActorUser = UserAvatarUser;

// A personal access token that acted on its own. `revoked` lets the UI flag
// credentials that no longer work while still naming them.
export interface ActorToken {
  id: string;
  name: string;
  revoked: boolean;
}

export type Actor =
  | { kind: "user"; user: ActorUser }
  | { kind: "token"; token: ActorToken };

// Returns null when no actor was recorded: both FKs NULL, or a row that
// predates the actor column. Users win over tokens, though the database
// forbids setting both. Falls back to email, then a placeholder, for the
// user label.
export function resolveActor(input: {
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  userImage: string | null;
  tokenId: string | null;
  tokenName: string | null;
  tokenRevokedAt: Date | null;
}): Actor | null {
  if (input.userId) {
    return {
      kind: "user",
      user: toUserAvatarUser({
        userId: input.userId,
        name: input.userName,
        email: input.userEmail,
        image: input.userImage,
      }),
    };
  }
  if (input.tokenId) {
    return {
      kind: "token",
      token: {
        id: input.tokenId,
        name: input.tokenName ?? "Unknown token",
        revoked: input.tokenRevokedAt !== null,
      },
    };
  }
  return null;
}

// Who is performing a write, as the audit columns need it: either a signed-in
// person or a token acting as itself. The token's name rides along so callers
// can label it in a response or notification without another lookup.
export type ActorRef =
  | { kind: "user"; userId: string }
  | { kind: "token"; tokenId: string; tokenName: string };

export function actorRefFromAuth(
  auth:
    | { authMethod: "session"; userId: string }
    | { authMethod: "token"; tokenId: string; tokenName: string }
): ActorRef {
  return auth.authMethod === "session"
    ? { kind: "user", userId: auth.userId }
    : { kind: "token", tokenId: auth.tokenId, tokenName: auth.tokenName };
}

// Splits an actor into the pair of nullable columns every audit table uses
// (for example `deleted_by` / `deleted_by_token`). At most one is non-null.
export function actorColumns(actor: ActorRef | null): {
  userId: string | null;
  tokenId: string | null;
} {
  if (!actor) {
    return { userId: null, tokenId: null };
  }
  return actor.kind === "user"
    ? { userId: actor.userId, tokenId: null }
    : { userId: null, tokenId: actor.tokenId };
}

export function actorDisplayName(actor: Actor): string {
  return actor.kind === "user" ? actor.user.displayName : actor.token.name;
}

// Splits an actor back into its user and token halves for API responses,
// which keep the person under the existing `*_by` / `*ByUser` fields and
// add the token beside them.
export function actorUser(actor: Actor | null): ActorUser | null {
  return actor?.kind === "user" ? actor.user : null;
}

export function actorToken(
  actor: Actor | null
): { id: string; name: string } | null {
  return actor?.kind === "token"
    ? { id: actor.token.id, name: actor.token.name }
    : null;
}
