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
