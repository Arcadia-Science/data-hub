import Link from "next/link";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

// The `::after` box covers the whole row, so a click anywhere on it follows the
// link. The row needs `relative`, and anything with its own behavior in the row
// goes inside `RowControl`.
export function RowLink({ className, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn(
        "rounded-sm after:absolute after:inset-0 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      {...props}
    />
  );
}

// Lifts a control above the row's stretched link so it still gets its own
// clicks, hover, and focus. `w-fit` leaves the rest of the cell to the link.
export function RowControl({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("relative z-10 w-fit", className)} {...props} />;
}
