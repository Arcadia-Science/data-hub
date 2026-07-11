import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
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
// Pass the display name as `children` so avatar + name share one hit target.
export function UserAvatarLink({
  user,
  size = "sm",
  className,
  children,
  ref,
  ...props
}: {
  user: UserAvatarUser;
  size?: "default" | "sm" | "lg";
  className?: string;
  children?: ReactNode;
} & Omit<ComponentProps<typeof Link>, "href">) {
  return (
    <Link
      aria-label={children ? undefined : `View ${user.displayName}'s runs`}
      className={cn(
        "inline-flex items-center outline-none ring-ring ring-offset-2 ring-offset-background transition-opacity hover:opacity-80 focus-visible:ring-2",
        children ? "gap-1.5 rounded-sm" : "rounded-full"
      )}
      href={`/users/${user.userId}`}
      ref={ref}
      {...props}
    >
      <UserAvatar className={className} size={size} user={user} />
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
