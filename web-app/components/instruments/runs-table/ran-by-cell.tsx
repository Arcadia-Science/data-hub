"use client";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { RunAttribution } from "@/lib/api/instrument-runs";
import { cn } from "@/lib/utils";
import { UserPlus, X } from "lucide-react";
import { useSession } from "next-auth/react";
import { useRouter } from "next/navigation";
import {
  startTransition,
  useOptimistic,
  useTransition,
  type MouseEvent,
} from "react";
import { toast } from "sonner";

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

type Action =
  | { kind: "claim"; user: RunAttribution }
  | { kind: "remove"; userId: string };

function applyOptimistic(
  current: RunAttribution[],
  action: Action
): RunAttribution[] {
  if (action.kind === "claim") {
    if (current.some((a) => a.userId === action.user.userId)) return current;
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
    if (!currentUserId) return;
    // Optimistically add "me" using a placeholder shape; the server response
    // via router.refresh() will reconcile the real display name / avatar.
    const me: RunAttribution = {
      userId: currentUserId,
      displayName: "You",
      initials: "YO",
      avatarUrl: null,
    };
    startTransition(() => dispatch({ kind: "claim", user: me }));
    startMutation(async () => {
      try {
        const res = await fetch(baseUrl, { method: "PUT" });
        if (!res.ok) throw new Error(await res.text());
        router.refresh();
      } catch {
        toast.error("Couldn't claim this run. Try again?");
        router.refresh();
      }
    });
  }

  function handleRemove(event: MouseEvent) {
    event.stopPropagation();
    if (!currentUserId) return;
    startTransition(() => dispatch({ kind: "remove", userId: currentUserId }));
    startMutation(async () => {
      try {
        const res = await fetch(baseUrl, { method: "DELETE" });
        if (!res.ok) throw new Error(await res.text());
        router.refresh();
      } catch {
        toast.error("Couldn't remove attribution. Try again?");
        router.refresh();
      }
    });
  }

  // Unattributed state: muted UserPlus icon normally; ghost "I ran this"
  // button on row hover. Pure CSS group-hover: no React hover state needed.
  return optimistic.length === 0 ? (
    <div className="flex items-center">
      {currentUserId ? (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                aria-hidden="true"
                className="inline-flex size-7 items-center justify-center rounded-full text-muted-foreground/60 group-hover:hidden"
              >
                <UserPlus className="size-4" />
              </span>
            </TooltipTrigger>
            <TooltipContent>Unattributed</TooltipContent>
          </Tooltip>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isPending}
            onClick={handleClaim}
            className="hidden h-7 px-2 text-xs font-medium group-hover:inline-flex"
          >
            I ran this
          </Button>
        </>
      ) : (
        <span className="inline-flex size-7 items-center justify-center text-muted-foreground/60">
          <UserPlus className="size-4" />
        </span>
      )}
    </div>
  ) : (
    <div className="flex items-center gap-2">
      <div className="flex -space-x-1.5">
        {optimistic.map((attribution) => (
          <Tooltip key={attribution.userId}>
            <TooltipTrigger asChild>
              <Avatar
                size="sm"
                className={cn(
                  "ring-2 ring-background",
                  attribution.userId === currentUserId && "ring-primary/30"
                )}
              >
                {attribution.avatarUrl ? (
                  <AvatarImage
                    src={attribution.avatarUrl}
                    alt={attribution.displayName}
                  />
                ) : null}
                <AvatarFallback className={avatarColor(attribution.userId)}>
                  {attribution.initials}
                </AvatarFallback>
              </Avatar>
            </TooltipTrigger>
            <TooltipContent>{attribution.displayName}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      {isSelfAttributed ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isPending}
          onClick={handleRemove}
          className="hidden h-6 gap-1 px-2 text-xs font-medium group-hover:inline-flex"
        >
          <X className="size-3" />
          Remove
        </Button>
      ) : currentUserId ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isPending}
          onClick={handleClaim}
          className="hidden h-6 px-2 text-xs font-medium group-hover:inline-flex"
        >
          I ran this too
        </Button>
      ) : null}
    </div>
  );
}
