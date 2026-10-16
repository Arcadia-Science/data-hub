import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// `compact` fits inside a tab or card. `roomy` stands in for a whole table.
const SIZE_CLASSES = {
  compact: { box: "py-8", icon: "size-6" },
  roomy: { box: "py-16", icon: "size-8" },
} as const;

/**
 * The dashed box shown in place of a list, table, or chart that has nothing in
 * it. One component keeps the spacing and wording style the same on every page.
 */
export function EmptyState({
  children,
  className,
  icon: Icon,
  size = "roomy",
}: {
  children: ReactNode;
  className?: string;
  icon: LucideIcon;
  size?: keyof typeof SIZE_CLASSES;
}) {
  const sizeClasses = SIZE_CLASSES[size];
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed bg-background dark:bg-muted",
        sizeClasses.box,
        className
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("text-muted-foreground", sizeClasses.icon)}
      />
      <p className="text-muted-foreground text-sm">{children}</p>
    </div>
  );
}
