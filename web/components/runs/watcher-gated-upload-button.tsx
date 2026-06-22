"use client";

import type * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

import { useWatcherStatus } from "./watcher-status-provider";

const DEFAULT_OFFLINE_TOOLTIP =
  "Watcher is offline. Bring the watcher online before requesting uploads — otherwise nothing will transfer to S3.";

/**
 * Renders an upload-style `Button` that is fully interactive when the
 * instrument's watcher is online, and a disabled button wrapped in an
 * explanatory tooltip when it is offline.
 *
 * Watcher status is read from the nearest `WatcherStatusProvider`, so
 * callers don't need to thread `isWatcherOnline` down through the tree.
 *
 * The offline path intentionally wraps the disabled button in a
 * `tabIndex={0}` span so the tooltip remains reachable via hover and
 * keyboard focus even though the underlying `<button>` can't receive events.
 */
export function WatcherGatedUploadButton({
  offlineTooltip = DEFAULT_OFFLINE_TOOLTIP,
  className,
  children,
  ...buttonProps
}: React.ComponentProps<typeof Button> & {
  offlineTooltip?: string;
}) {
  const { isWatcherOnline } = useWatcherStatus();

  if (isWatcherOnline) {
    return (
      <Button className={className} {...buttonProps}>
        {children}
      </Button>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0}>
          <Button
            {...buttonProps}
            className={cn("pointer-events-none", className)}
            disabled
          >
            {children}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs" side="top">
        {offlineTooltip}
      </TooltipContent>
    </Tooltip>
  );
}
