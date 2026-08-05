// Deterministic per-user avatar styling and the shared `UserAvatar` props
// shape. Keeping the palette, hashing, and constructor here means the same
// user gets the same bubble color and initials everywhere they show up.

export const AVATAR_PALETTE = [
  "bg-blue-200 text-blue-900 dark:bg-blue-800 dark:text-blue-100",
  "bg-emerald-200 text-emerald-900 dark:bg-emerald-800 dark:text-emerald-100",
  "bg-violet-200 text-violet-900 dark:bg-violet-800 dark:text-violet-100",
  "bg-amber-200 text-amber-900 dark:bg-amber-800 dark:text-amber-100",
  "bg-rose-200 text-rose-900 dark:bg-rose-800 dark:text-rose-100",
  "bg-teal-200 text-teal-900 dark:bg-teal-800 dark:text-teal-100",
  "bg-fuchsia-200 text-fuchsia-900 dark:bg-fuchsia-800 dark:text-fuchsia-100",
  "bg-orange-200 text-orange-900 dark:bg-orange-800 dark:text-orange-100",
];

export interface UserAvatarUser {
  avatarUrl: string | null;
  displayName: string;
  initials: string;
  userId: string;
}

export function avatarColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    // biome-ignore lint/suspicious/noBitwiseOperators: | 0 coerces the hash to a 32-bit integer
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

export function toInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts.at(-1)?.[0]).toUpperCase();
}

export function toUserAvatarUser(input: {
  userId: string;
  name?: string | null;
  email?: string | null;
  image?: string | null;
}): UserAvatarUser {
  const displayName = input.name ?? input.email ?? "Unknown user";
  return {
    userId: input.userId,
    displayName,
    initials: toInitials(displayName),
    avatarUrl: input.image ?? null,
  };
}
