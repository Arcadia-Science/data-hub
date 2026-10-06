import { KeyRound } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { UserAvatar, UserAvatarLink } from "@/components/user-avatar";
import type { Actor, ActorToken } from "@/lib/api/actor";
import { cn } from "@/lib/utils";

/** Avatar for a personal access token: a key icon in place of initials. */
export function TokenAvatar({
  size = "sm",
  className,
}: {
  size?: "default" | "sm" | "lg";
  className?: string;
}) {
  return (
    <Avatar className={className} size={size}>
      <AvatarFallback className="bg-muted text-muted-foreground">
        <KeyRound aria-hidden="true" className="size-3" />
        {/* The key icon carries no text, so name it for screen readers. */}
        <span className="sr-only">API token</span>
      </AvatarFallback>
    </Avatar>
  );
}

// Tokens have no profile page, so unlike `UserAvatarLink` this is not a link.
// A revoked token keeps its name so history stays readable.
export function TokenActorLabel({
  token,
  size = "sm",
  nameClassName = "font-medium",
  className,
}: {
  token: ActorToken;
  size?: "default" | "sm" | "lg";
  nameClassName?: string;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <TokenAvatar size={size} />
      <span className={nameClassName}>{token.name}</span>
      {token.revoked ? (
        <span className="text-muted-foreground">(revoked)</span>
      ) : null}
    </span>
  );
}

// Avatar only, for rows that are already a link (a nested `UserAvatarLink`
// would be invalid markup).
export function ActorAvatar({
  actor,
  size = "sm",
  className,
}: {
  actor: Actor;
  size?: "default" | "sm" | "lg";
  className?: string;
}) {
  return actor.kind === "token" ? (
    <TokenAvatar className={className} size={size} />
  ) : (
    <UserAvatar className={className} size={size} user={actor.user} />
  );
}

// The one place that branches on who acted, so screens that show an actor
// (headers, comments, notifications) don't each repeat the check.
export function ActorLabel({
  actor,
  size = "sm",
  nameClassName = "font-medium",
  className,
}: {
  actor: Actor;
  size?: "default" | "sm" | "lg";
  nameClassName?: string;
  className?: string;
}) {
  if (actor.kind === "token") {
    return (
      <TokenActorLabel
        className={className}
        nameClassName={nameClassName}
        size={size}
        token={actor.token}
      />
    );
  }
  return (
    <UserAvatarLink className={className} size={size} user={actor.user}>
      <span className={nameClassName}>{actor.user.displayName}</span>
    </UserAvatarLink>
  );
}
