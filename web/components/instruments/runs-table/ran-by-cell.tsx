"use client";

import { UserPlus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { type MouseEvent, useOptimistic, useTransition } from "react";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { RunAttribution } from "@/lib/api/instrument-runs";
import { cn } from "@/lib/utils";

// A small, deterministic palette keyed by userId hash so the same user always
// gets the same color across rows. Tailwind tokens are baked in (we can't
// interpolate class names safely).
const AVATAR_PALETTE = [
  "bg-blue-200 text-blue-900 dark:bg-blue-800 dark:text-blue-100",
  "bg-emerald-200 text-emerald-900 dark:bg-emerald-800 dark:text-emerald-100",
  "bg-violet-200 text-violet-900 dark:bg-violet-800 dark:text-violet-100",
  "bg-amber-200 text-amber-900 dark:bg-amber-800 dark:text-amber-100",
  "bg-rose-200 text-rose-900 dark:bg-rose-800 dark:text-rose-100",
  "bg-teal-200 text-teal-900 dark:bg-teal-800 dark:text-teal-100",
  "bg-fuchsia-200 text-fuchsia-900 dark:bg-fuchsia-800 dark:text-fuchsia-100",
  "bg-orange-200 text-orange-900 dark:bg-orange-800 dark:text-orange-100",
];

function avatarColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

// Mirrors the server-side helper in lib/api/instrument-runs.ts so optimistic
// attributions render with the same initials the server will echo back,
// avoiding a fallback flip on reconcile.
function toInitials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return "?";
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts.at(-1)[0]).toUpperCase();
}

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

export function RanByCell({
  instrumentId,
  runId,
  attributions,
}: {
  instrumentId: string;
  runId: string;
  attributions: RunAttribution[];
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
    // Optimistic shape mirrors what the server will send back so the avatar
    // bubble doesn't flip from a colored "YO" fallback to the real photo on
    // reconcile. Pulls displayName / image straight from the session.
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

  // Each action is an icon-only button; its label lives in a tooltip so the
  // cell width is naturally fixed. Both branches share the same wrapper height
  // so rows don't reflow depending on whether a run has attributions.
  return optimistic.length === 0 ? (
    <div className="flex h-7 items-center">
      {currentUserId ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="I ran this"
              className="size-7 text-muted-foreground/70 hover:text-foreground"
              disabled={isPending}
              onClick={handleClaim}
              size="icon"
              type="button"
              variant="ghost"
            >
              <UserPlus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>I ran this</TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex size-7 items-center justify-center text-muted-foreground/60">
              <UserPlus aria-hidden="true" className="size-4" />
              <span className="sr-only">Unattributed</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>Unattributed</TooltipContent>
        </Tooltip>
      )}
    </div>
  ) : (
    <div className="group/ranby flex h-7 items-center gap-1">
      <div className="flex -space-x-1.5">
        {optimistic.map((attribution) => {
          const isSelf = attribution.userId === currentUserId;
          return (
            <Tooltip key={attribution.userId}>
              <TooltipTrigger asChild>
                <Avatar
                  className={cn(
                    "ring-2 ring-background",
                    isSelf && "ring-primary/30"
                  )}
                  data-self-attribution={isSelf || undefined}
                  size="sm"
                >
                  {attribution.avatarUrl ? (
                    <AvatarImage
                      alt={attribution.displayName}
                      src={attribution.avatarUrl}
                    />
                  ) : null}
                  <AvatarFallback className={avatarColor(attribution.userId)}>
                    {attribution.initials}
                  </AvatarFallback>
                </Avatar>
              </TooltipTrigger>
              <TooltipContent>{attribution.displayName}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      {isSelfAttributed ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="Remove my attribution"
              className={cn(
                "size-6 text-muted-foreground/70 hover:text-foreground",
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
              <X className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Remove my attribution</TooltipContent>
        </Tooltip>
      ) : currentUserId ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              aria-label="I ran this too"
              className="size-6 text-muted-foreground/70 hover:text-foreground"
              disabled={isPending}
              onClick={handleClaim}
              size="icon"
              type="button"
              variant="ghost"
            >
              <UserPlus className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>I ran this too</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  );
}
