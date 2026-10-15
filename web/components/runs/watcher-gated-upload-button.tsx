"use client";

import type * as React from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";

import { useWatcherStatus } from "./watcher-status-provider";

const DEFAULT_OFFLINE_TOOLTIP =
  "Watcher is offline. Bring the watcher online before requesting uploads — otherwise nothing will transfer to S3.";

/**
 * Renders an upload-style `Button` that is fully interactive when the
 * instrument's watcher is online, and a dimmed button with an
 * explanatory tooltip when it is offline.
 *
 * Watcher status is read from the nearest `WatcherStatusProvider`, so
 * callers don't need to thread `isWatcherOnline` down through the tree.
 *
 * The offline path uses `DisabledReasonButton`, so the tooltip stays reachable
 * by hover and by keyboard focus.
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
    <DisabledReasonButton
      {...buttonProps}
      className={className}
      reason={offlineTooltip}
    >
      {children}
    </DisabledReasonButton>
  );
}
