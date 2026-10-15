import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 cursor-pointer select-none items-center justify-center whitespace-nowrap rounded-md border border-transparent bg-clip-padding font-medium text-sm outline-none transition-all focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:active:translate-y-0 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground hover:bg-primary/80 aria-disabled:hover:bg-primary",
        outline:
          "border-border bg-background shadow-xs hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground aria-disabled:hover:bg-background aria-disabled:hover:text-inherit dark:border-input dark:bg-input/30 dark:hover:bg-input/50 dark:aria-disabled:hover:bg-input/30",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-disabled:hover:bg-secondary aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-muted hover:text-foreground aria-disabled:hover:bg-transparent aria-disabled:hover:text-inherit aria-expanded:bg-muted aria-expanded:text-foreground dark:hover:bg-muted/50 dark:aria-disabled:hover:bg-transparent",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 aria-disabled:hover:bg-destructive/10 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 dark:hover:bg-destructive/30 dark:aria-disabled:hover:bg-destructive/20",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-9 gap-1.5 in-data-[slot=button-group]:rounded-md px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 in-data-[slot=button-group]:rounded-md rounded-[min(var(--radius-md),8px)] px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1 in-data-[slot=button-group]:rounded-md rounded-[min(var(--radius-md),10px)] px-2.5 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5",
        lg: "h-10 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-9",
        "icon-xs":
          "size-6 in-data-[slot=button-group]:rounded-md rounded-[min(var(--radius-md),8px)] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-8 in-data-[slot=button-group]:rounded-md rounded-[min(var(--radius-md),10px)]",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      data-size={size}
      data-slot="button"
      data-variant={variant}
      {...props}
    />
  );
}

export { Button, buttonVariants };
