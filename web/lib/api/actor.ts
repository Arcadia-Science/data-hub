import { toUserAvatarUser, type UserAvatarUser } from "@/lib/avatar-color";

// Who performed an audited action (retiring an instrument, deregistering a
// watcher). Aliases `UserAvatarUser` so it feeds `<UserAvatar>` directly.
export type ActorUser = UserAvatarUser;

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
  return toUserAvatarUser({
    userId: input.userId,
    name: input.name,
    email: input.email,
    image: input.image,
  });
}
