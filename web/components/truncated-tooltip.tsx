"use client";

import { type ReactElement, type ReactNode, useRef, useState } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Shows the full text of a cut-off name in a tooltip, and only when it is cut
 * off. `children` is the focusable element that holds the truncated text, so
 * the tooltip opens on keyboard focus as well as on hover. A native `title`
 * would show for the mouse only.
 */
export function TruncatedTooltip({
  children,
  text,
}: {
  children: ReactElement;
  text: ReactNode;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <Tooltip
      onOpenChange={(next) => {
        const element = triggerRef.current;
        setOpen(
          next && element !== null && element.scrollWidth > element.clientWidth
        );
      }}
      open={open}
    >
      <TooltipTrigger asChild ref={triggerRef}>
        {children}
      </TooltipTrigger>
      <TooltipContent className="max-w-md break-all">{text}</TooltipContent>
    </Tooltip>
  );
}
