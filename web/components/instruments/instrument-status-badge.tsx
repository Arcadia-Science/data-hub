import { CheckCircle2, Clock, Power } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { InstrumentListItem } from "@/lib/api/instruments";
import { cn } from "@/lib/utils";

/**
 * Instrument lifecycle status, distinct from the watcher connectivity shown by
 * `WatcherStatusBadge`. Surfaced in the instruments table only while an
 * instrument is `pending` (awaiting admin Confirm); active rows fall back to
 * their watcher status, which is the more useful signal once activated.
 */
export type InstrumentLifecycleStatus = InstrumentListItem["status"];

const STATUS_CONFIG: Record<
  InstrumentLifecycleStatus,
  { label: string; Icon: typeof Clock; className: string }
> = {
  pending: {
    label: "Pending",
    Icon: Clock,
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  },
  active: {
    label: "Active",
    Icon: CheckCircle2,
    className:
      "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  },
  inactive: {
    label: "Retired",
    Icon: Power,
    className: "bg-muted text-muted-foreground",
  },
};

export function InstrumentStatusBadge({
  status,
  className,
}: {
  status: InstrumentLifecycleStatus;
  className?: string;
}) {
  const { label, Icon, className: variantClassName } = STATUS_CONFIG[status];
  return (
    <Badge className={cn(variantClassName, className)}>
      <Icon />
      {label}
    </Badge>
  );
}
