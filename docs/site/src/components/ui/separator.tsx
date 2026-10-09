import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

/** Visual divider. Always decorative — no ARIA role required. */
export function Separator({
  className,
  orientation = "horizontal",
  ...props
}: ComponentProps<"div"> & {
  orientation?: "horizontal" | "vertical";
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "shrink-0 bg-fd-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className
      )}
      data-orientation={orientation}
      data-slot="separator"
      {...props}
    />
  );
}
