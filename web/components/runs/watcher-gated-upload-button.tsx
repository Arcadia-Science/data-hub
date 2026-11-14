"use client";

import { RefreshCw, WifiOff } from "lucide-react";
import { type ComponentProps, useId } from "react";
import { DisabledReasonButton } from "@/components/disabled-reason-button";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { UploadReasonTone } from "@/lib/runs/upload-availability";
import { cn } from "@/lib/utils";

import { useWatcherStatus } from "./watcher-status-provider";

const TONE_CLASSNAME: Record<UploadReasonTone, string> = {
  destructive: "text-red-700 dark:text-red-400",
  info: "text-blue-700 dark:text-blue-400",
  muted: "text-muted-foreground",
};

/**
 * Renders an upload-style `Button` that follows the run page's upload table
 * (see `getRunUploadAvailability`): fully interactive while the watcher is
 * online or restarting, and a dimmed button with the reason while it can't
 * take uploads.
 *
 * The state is read from the nearest `WatcherStatusProvider`, so callers don't
 * thread it down through the tree. The reason is the button's tooltip and its
 * accessible description, so it reaches a keyboard or screen reader user
 * without a visible line. Put an `UploadReasonLine` beside the button where one
 * line covers several buttons.
 *
 * A disabled button uses `DisabledReasonButton`, so it stays focusable and its
 * tooltip opens on focus as well as hover. Each state owns its tooltip, so a
 * caller passes `enabledTooltip` here instead of wrapping the button in a
 * second one.
 */
export function WatcherGatedUploadButton({
  enabledTooltip,
  className,
  children,
  ...buttonProps
}: ComponentProps<typeof Button> & {
  /** What the button does, as a tooltip while Upload is available. */
  enabledTooltip?: string;
}) {
  const { upload } = useWatcherStatus();
  const reasonId = useId();
  const describedBy = upload.reason ? reasonId : undefined;
  const reasonText = upload.reason ? (
    <span className="sr-only" id={reasonId}>
      {upload.reason}
    </span>
  ) : null;

  if (!upload.enabled) {
    return (
      <>
        <DisabledReasonButton
          {...buttonProps}
          aria-describedby={describedBy}
          className={className}
          reason={upload.reason}
        >
          {children}
        </DisabledReasonButton>
        {reasonText}
      </>
    );
  }

  const button = (
    <Button
      aria-describedby={describedBy}
      className={className}
      {...buttonProps}
    >
      {children}
    </Button>
  );
  const tooltip = [enabledTooltip, upload.reason].filter(Boolean);
  if (tooltip.length === 0) {
    return button;
  }
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent className="max-w-xs">
          {tooltip.map((line) => (
            <p key={line}>{line}</p>
          ))}
        </TooltipContent>
      </Tooltip>
      {reasonText}
    </>
  );
}

/**
 * The line beside an Upload button that says why uploads wait or can't start:
 * blue while the instrument PC restarts, red while the watcher is offline,
 * grey for the quieter states. Renders nothing while Online. It is plain text,
 * so it is visible to everyone and not only in a tooltip.
 */
export function UploadReasonLine({ className }: { className?: string }) {
  const { upload } = useWatcherStatus();
  if (!(upload.reason && upload.tone)) {
    return null;
  }
  let Icon: typeof RefreshCw | null = null;
  if (upload.tone === "info") {
    Icon = RefreshCw;
  } else if (upload.tone === "destructive") {
    Icon = WifiOff;
  }
  return (
    <p
      className={cn(
        "flex items-center gap-1.5 text-[13px] leading-snug",
        TONE_CLASSNAME[upload.tone],
        className
      )}
    >
      {Icon ? <Icon aria-hidden="true" className="size-3.5 shrink-0" /> : null}
      {upload.reason}
    </p>
  );
}
