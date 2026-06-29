import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden whitespace-nowrap rounded-4xl px-2 py-0.5 font-medium text-xs transition-all focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default:
          "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300 [a]:hover:bg-blue-100 dark:[a]:hover:bg-blue-900",
        secondary:
          "bg-slate-100 text-slate-700 dark:bg-slate-950 dark:text-slate-300 [a]:hover:bg-slate-100 dark:[a]:hover:bg-slate-900",
        destructive:
          "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300 [a]:hover:bg-red-100 dark:[a]:hover:bg-red-900",
        outline:
          "bg-slate-100 text-slate-700 dark:bg-slate-950 dark:text-slate-300 [a]:hover:bg-slate-100 dark:[a]:hover:bg-slate-900",
        ghost:
          "hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
);

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span";

  return (
    <Comp
      className={cn(badgeVariants({ variant }), className)}
      data-slot="badge"
      data-variant={variant}
      {...props}
    />
  );
}

export { Badge, badgeVariants };
