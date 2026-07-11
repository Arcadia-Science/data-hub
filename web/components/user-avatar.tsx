import Link from "next/link";
import type { ComponentProps } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { avatarColor } from "@/lib/avatar-color";
import { cn } from "@/lib/utils";

export interface UserAvatarUser {
  avatarUrl: string | null;
  displayName: string;
  initials: string;
  userId: string;
}

export function UserAvatar({
  user,
  size = "sm",
  className,
  ...props
}: {
  user: UserAvatarUser;
  size?: "default" | "sm" | "lg";
  className?: string;
} & Omit<ComponentProps<typeof Avatar>, "size">) {
  return (
    <Avatar className={className} size={size} {...props}>
      {user.avatarUrl ? (
        <AvatarImage alt={user.displayName} src={user.avatarUrl} />
      ) : null}
      <AvatarFallback className={avatarColor(user.userId)}>
        {user.initials}
      </AvatarFallback>
    </Avatar>
  );
}

// A separate composed component rather than a `clickable` prop on `UserAvatar`,
// so the plain avatar stays usable where a nested link would be invalid (inside
// another link or a control that owns the click). Forwards `ref`/props to the
// `Link` so it can act as a Radix `asChild` trigger (e.g. inside a tooltip).
export function UserAvatarLink({
  user,
  size = "sm",
  className,
  ref,
  ...props
}: {
  user: UserAvatarUser;
  size?: "default" | "sm" | "lg";
  className?: string;
} & Omit<ComponentProps<typeof Link>, "href">) {
  return (
    <Link
      aria-label={`View ${user.displayName}'s runs`}
      className="inline-flex rounded-full outline-none ring-ring ring-offset-2 ring-offset-background transition-opacity hover:opacity-80 focus-visible:ring-2"
      href={`/users/${user.userId}`}
      ref={ref}
      {...props}
    >
      <UserAvatar className={className} size={size} user={user} />
    </Link>
  );
}

/** Avatar with no user identity — renders a neutral "?" fallback. */
export function UnknownUserAvatar({
  size = "sm",
  className,
}: {
  size?: "default" | "sm" | "lg";
  className?: string;
}) {
  return (
    <Avatar className={cn(className)} size={size}>
      <AvatarFallback>?</AvatarFallback>
    </Avatar>
  );
}
