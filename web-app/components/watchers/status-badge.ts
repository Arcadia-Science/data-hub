import type { EffectiveStatus } from "@/lib/api/watchers";

export const statusBadge: Record<
  EffectiveStatus,
  {
    label: string;
    variant: "default" | "outline" | "secondary" | "destructive";
  }
> = {
  watching: { label: "Watching", variant: "default" },
  stale: { label: "Stale", variant: "destructive" },
  stopped: { label: "Stopped", variant: "secondary" },
  registered: { label: "Registered", variant: "outline" },
};
