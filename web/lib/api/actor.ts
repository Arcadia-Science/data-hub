import type { UserAvatarUser } from "@/components/user-avatar";

// Who performed an audited action (retiring an instrument, deregistering a
// watcher). Aliases `UserAvatarUser` so it feeds `<UserAvatar>` directly.
export type ActorUser = UserAvatarUser;

export function toInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + (parts.at(-1)?.[0] ?? "")).toUpperCase();
}

// Returns null when no actor was recorded: a NULL FK, or a row that predates
// the actor column. Falls back to email, then a placeholder, for the label.
export function resolveActorUser(input: {
  userId: string | null;
  name: string | null;
  email: string | null;
  image: string | null;
}): ActorUser | null {
  if (!input.userId) {
    return null;
  }
  const displayName = input.name ?? input.email ?? "Unknown user";
  return {
    userId: input.userId,
    displayName,
    initials: toInitials(displayName),
    avatarUrl: input.image,
  };
}
