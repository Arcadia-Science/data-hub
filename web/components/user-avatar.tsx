import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { avatarColor, type UserAvatarUser } from "@/lib/avatar-color";
import { cn } from "@/lib/utils";

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

// Composed link rather than a `clickable` prop on `UserAvatar`, so the plain
// avatar stays usable where a nested link would be invalid. Pass the display
// name (or other label) as `children` so the hit target covers avatar + text;
// omit children for avatar-only links (e.g. stacked attribution tooltips).
// Forwards `ref`/props to the `Link` so it can act as a Radix `asChild` trigger.
export function UserAvatarLink({
  user,
  size = "sm",
  avatarClassName,
  className,
  children,
  ref,
  ...props
}: {
  user: UserAvatarUser;
  size?: "default" | "sm" | "lg";
  avatarClassName?: string;
  className?: string;
  children?: ReactNode;
} & Omit<ComponentProps<typeof Link>, "href">) {
  return (
    <Link
      aria-label={`View ${user.displayName}'s runs`}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm outline-none ring-ring ring-offset-2 ring-offset-background transition-opacity hover:opacity-80 focus-visible:ring-2",
        className
      )}
      href={`/users/${user.userId}`}
      ref={ref}
      {...props}
    >
      <UserAvatar className={avatarClassName} size={size} user={user} />
      {children}
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
