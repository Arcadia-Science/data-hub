import { Badge } from "@/components/ui/badge";
import { GREEN_BADGE_COLORS } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";
import type { RolloutPill as RolloutPillState } from "@/lib/watchers/roster";

const TONE_CLASSNAME: Record<RolloutPillState["tone"], string> = {
  current: GREEN_BADGE_COLORS,
  behind: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

/** How many active watchers run the latest version, in green or amber. */
export function RolloutPill({ pill }: { pill: RolloutPillState }) {
  return (
    <Badge className={cn("h-6 px-2.5 text-xs", TONE_CLASSNAME[pill.tone])}>
      {pill.text}
    </Badge>
  );
}
