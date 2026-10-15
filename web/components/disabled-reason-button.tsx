"use client";

import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * A button that cannot be used right now, with the reason in a tooltip. A real
 * `disabled` button is skipped by the Tab key and ignores hover, so keyboard
 * users never learn why it is off. This one uses `aria-disabled` instead: it
 * stays a single tab stop, screen readers announce it as dimmed, and the
 * tooltip opens on focus as well as hover. Clicks do nothing.
 */
export function DisabledReasonButton({
  children,
  className,
  reason,
  tooltipClassName,
  ...buttonProps
}: Omit<ComponentProps<typeof Button>, "disabled"> & {
  reason: ReactNode;
  tooltipClassName?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          {...buttonProps}
          aria-disabled="true"
          className={cn("cursor-not-allowed opacity-50", className)}
          // `disabled` would take the button out of the tab order again.
          disabled={undefined}
          onClick={(event) => event.preventDefault()}
          type="button"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent className={cn("max-w-xs", tooltipClassName)} side="top">
        {reason}
      </TooltipContent>
    </Tooltip>
  );
}
