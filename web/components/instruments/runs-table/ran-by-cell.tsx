"use client";

import { UserPlus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { type MouseEvent, useOptimistic, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UserAvatar } from "@/components/user-avatar";
import type { RunAttribution } from "@/lib/api/instrument-runs";
import { toInitials } from "@/lib/avatar-color";
import { cn } from "@/lib/utils";

type Action =
  | { kind: "claim"; user: RunAttribution }
  | { kind: "remove"; userId: string };

function applyOptimistic(
  current: RunAttribution[],
  action: Action
): RunAttribution[] {
  if (action.kind === "claim") {
    if (current.some((a) => a.userId === action.user.userId)) {
      return current;
    }
    return [...current, action.user];
  }
  return current.filter((a) => a.userId !== action.userId);
}

function AttributionAvatars({
  attributions,
  currentUserId,
  showName,
  compact,
}: {
  attributions: RunAttribution[];
  currentUserId: string | null;
  showName: boolean;
  compact: boolean;
}) {
  const avatarClassName = cn(
    compact
      ? "size-5 ring-1 ring-background [&_[data-slot=avatar-fallback]]:text-[10px]"
      : "ring-2 ring-background"
  );
  const nameClassName = compact
    ? "font-medium text-foreground text-xs"
    : "font-medium text-foreground text-sm";
  const rowClassName = compact
    ? "inline-flex h-5 items-center gap-1.5"
    : "inline-flex items-center gap-2";

  if (showName && attributions.length === 1) {
    const attribution = attributions[0];
    const isSelf = attribution.userId === currentUserId;
    return (
      <span className={rowClassName}>
        <UserAvatar
          className={cn(avatarClassName, isSelf && "ring-primary/30")}
          data-self-attribution={isSelf || undefined}
          size="sm"
          user={attribution}
        />
        <span className={nameClassName}>{attribution.displayName}</span>
      </span>
    );
  }

  if (showName && attributions.length > 1) {
    const hiddenCount = attributions.length - 1;
    return (
      <span className={rowClassName}>
        <span className={cn("flex", compact ? "-space-x-1" : "-space-x-1.5")}>
          {attributions.map((attribution) => {
            const isSelf = attribution.userId === currentUserId;
            return (
              <Tooltip key={attribution.userId}>
                <TooltipTrigger asChild>
                  <UserAvatar
                    className={cn(avatarClassName, isSelf && "ring-primary/30")}
                    data-self-attribution={isSelf || undefined}
                    size="sm"
                    user={attribution}
                  />
                </TooltipTrigger>
                <TooltipContent>{attribution.displayName}</TooltipContent>
              </Tooltip>
            );
          })}
        </span>
        <span className={nameClassName}>
          {attributions[0].displayName}
          <span className="text-muted-foreground"> +{hiddenCount}</span>
        </span>
      </span>
    );
  }

  return (
    <div className="flex -space-x-1.5">
      {attributions.map((attribution) => {
        const isSelf = attribution.userId === currentUserId;
        return (
          <Tooltip key={attribution.userId}>
            <TooltipTrigger asChild>
              <UserAvatar
                className={cn(
                  "ring-2 ring-background",
                  isSelf && "ring-primary/30"
                )}
                data-self-attribution={isSelf || undefined}
                size="sm"
                user={attribution}
              />
            </TooltipTrigger>
            <TooltipContent>{attribution.displayName}</TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

export function RanByCell({
  instrumentId,
  runId,
  attributions,
  showName = false,
  compact = false,
}: {
  instrumentId: string;
  runId: string;
  attributions: RunAttribution[];
  showName?: boolean;
  compact?: boolean;
}) {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id ?? null;
  const router = useRouter();
  const [isPending, startMutation] = useTransition();
  const [optimistic, dispatch] = useOptimistic(attributions, applyOptimistic);

  const selfAttribution = currentUserId
    ? (optimistic.find((a) => a.userId === currentUserId) ?? null)
    : null;
  const isSelfAttributed = selfAttribution !== null;

  const baseUrl = `/api/v1/instruments/${instrumentId}/runs/${encodeURIComponent(
    runId
  )}/attributions/me`;

  function handleClaim(event: MouseEvent) {
    event.stopPropagation();
    if (!currentUserId) {
      return;
    }
    const displayName = session?.user?.name ?? session?.user?.email ?? "You";
    const me: RunAttribution = {
      userId: currentUserId,
      displayName,
      initials: toInitials(displayName),
      avatarUrl: session?.user?.image ?? null,
    };
    startMutation(async () => {
      dispatch({ kind: "claim", user: me });
      try {
        const res = await fetch(baseUrl, { method: "PUT" });
        if (!res.ok) {
          throw new Error(await res.text());
        }
      } catch {
        toast.error("Couldn't claim this run. Try again?");
      } finally {
        router.refresh();
      }
    });
  }

  function handleRemove(event: MouseEvent) {
    event.stopPropagation();
    if (!currentUserId) {
      return;
    }
    startMutation(async () => {
      dispatch({ kind: "remove", userId: currentUserId });
      try {
        const res = await fetch(baseUrl, { method: "DELETE" });
        if (!res.ok) {
          throw new Error(await res.text());
        }
      } catch {
        toast.error("Couldn't remove attribution. Try again?");
      } finally {
        router.refresh();
      }
    });
  }

  const actionButtonSize = compact ? "size-5" : showName ? "size-7" : "size-6";
  const actionIconSize = compact ? "size-3" : showName ? "size-4" : "size-3.5";
  const rowHeight = compact ? "h-5" : "h-7";

  return optimistic.length === 0 ? (
    <div className={cn("flex items-center", rowHeight)}>
      {currentUserId ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="I ran this"
              className={cn(
                actionButtonSize,
                "text-muted-foreground/70 hover:text-foreground"
              )}
              disabled={isPending}
              onClick={handleClaim}
              size="icon"
              type="button"
              variant="ghost"
            >
              <UserPlus className={actionIconSize} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>I ran this</TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn(
                "inline-flex items-center justify-center text-muted-foreground/60",
                actionButtonSize
              )}
            >
              <UserPlus aria-hidden="true" className={actionIconSize} />
              <span className="sr-only">Unattributed</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>Unattributed</TooltipContent>
        </Tooltip>
      )}
    </div>
  ) : (
    <div className={cn("group/ranby flex items-center gap-1", rowHeight)}>
      <AttributionAvatars
        attributions={optimistic}
        compact={compact}
        currentUserId={currentUserId}
        showName={showName}
      />
      {isSelfAttributed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Remove my attribution"
              className={cn(
                actionButtonSize,
                "text-muted-foreground/70 hover:text-foreground",
                "opacity-0 transition-opacity",
                "group-has-[[data-self-attribution]:hover]/ranby:opacity-100",
                "hover:opacity-100 focus-visible:opacity-100"
              )}
              disabled={isPending}
              onClick={handleRemove}
              size="icon"
              type="button"
              variant="ghost"
            >
              <X className={actionIconSize} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove my attribution</TooltipContent>
        </Tooltip>
      ) : currentUserId ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="I ran this too"
              className={cn(
                actionButtonSize,
                "text-muted-foreground/70 hover:text-foreground"
              )}
              disabled={isPending}
              onClick={handleClaim}
              size="icon"
              type="button"
              variant="ghost"
            >
              <UserPlus className={actionIconSize} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>I ran this too</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
