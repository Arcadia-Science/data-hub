import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

export const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center whitespace-nowrap rounded-md border border-transparent px-2 py-0.5 font-medium text-xs",
  {
    variants: {
      variant: {
        default: "bg-fd-primary text-fd-primary-foreground",
        secondary: "bg-fd-secondary text-fd-secondary-foreground",
        outline: "border-fd-border text-fd-foreground",
        success:
          "bg-fd-success/15 text-fd-success dark:bg-fd-success/20 dark:text-fd-success",
        warning:
          "bg-fd-warning/15 text-fd-warning dark:bg-fd-warning/20 dark:text-fd-warning",
        destructive:
          "bg-fd-error/15 text-fd-error dark:bg-fd-error/20 dark:text-fd-error",
        info: "bg-fd-info/15 text-fd-info dark:bg-fd-info/20 dark:text-fd-info",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

export function Badge({
  className,
  variant = "default",
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return (
    <span
      className={cn(badgeVariants({ variant }), className)}
      data-slot="badge"
      data-variant={variant}
      {...props}
    />
  );
}
