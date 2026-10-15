"use client";

import { Bell } from "lucide-react";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const DEFAULT_ARIA_LABEL = "Notify me about new runs on this instrument";

interface InstrumentNotificationProps {
  ariaLabel?: string;
  initialEnabled: boolean;
  instrumentId: string;
  masterMuted: boolean;
  size?: "sm" | "default";
}

// Both layouts share this state and the request. They differ only in markup.
function useInstrumentNotification({
  initialEnabled,
  instrumentId,
  masterMuted,
}: Pick<
  InstrumentNotificationProps,
  "initialEnabled" | "instrumentId" | "masterMuted"
>) {
  // Optimistic local state mirrors the row's `enabled` column. We flip
  // it immediately for visual feedback and roll back if the server says
  // no — the alternative ("await the round-trip then update") makes the
  // switch feel laggy on every toggle.
  const [enabled, setEnabled] = useState(initialEnabled);
  const [isPending, startTransition] = useTransition();

  const handleChange = (next: boolean) => {
    const previous = enabled;
    setEnabled(next);

    // Wrapping the network call in `startTransition` keeps callback
    // identity stable across renders and lets the Switch report its
    // pending state via `disabled`.
    startTransition(async () => {
      try {
        const res = await fetch(
          `/api/v1/settings/notifications/instruments/${encodeURIComponent(
            instrumentId
          )}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: next }),
          }
        );
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (err) {
        setEnabled(previous);
        toast.error("Couldn't update instrument notifications", {
          description:
            err instanceof Error
              ? err.message
              : "An unexpected error occurred.",
        });
      }
    });
  };

  // Visual logic mirrors the WatcherReleaseForm "Mandatory update"
  // pattern: we never overwrite the underlying value when masterMuted
  // is true — the user's per-instrument intent is preserved through a
  // master toggle round-trip — but the switch reads as off until the
  // master mute is cleared.
  const tooltip = masterMuted
    ? "All instrument notifications muted in Settings"
    : enabled
      ? "Notifying you about new runs on this instrument"
      : "Click to be notified about new runs on this instrument";

  return {
    checked: enabled && !masterMuted,
    disabled: masterMuted || isPending,
    handleChange,
    tooltip,
  };
}

/**
 * A bare toggle for a table cell or settings list. The tooltip is wrapped here
 * so callers don't have to know about the active vs muted copy.
 */
export function InstrumentNotificationSwitch({
  ariaLabel = DEFAULT_ARIA_LABEL,
  size = "default",
  ...props
}: InstrumentNotificationProps) {
  const { checked, disabled, handleChange, tooltip } =
    useInstrumentNotification(props);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* The wrapper span keeps the tooltip target hoverable even when
            the switch is disabled — a disabled Radix Switch swallows
            pointer events otherwise. */}
        <span className="inline-flex">
          <Switch
            aria-label={ariaLabel}
            checked={checked}
            disabled={disabled}
            onCheckedChange={handleChange}
            size={size}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A labelled pill for the instrument header: a bell icon, "Notifications", and
 * the toggle. The whole pill is clickable, and hover shows the tooltip.
 */
export function InstrumentNotificationPill({
  ariaLabel = DEFAULT_ARIA_LABEL,
  size = "default",
  ...props
}: InstrumentNotificationProps) {
  const switchId = useId();
  const { checked, disabled, handleChange, tooltip } =
    useInstrumentNotification(props);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A `<label>` bound to the switch makes the whole pill toggle it and
            hover the tooltip. The switch is the label's only labelable
            control, so the markup stays valid. */}
        <label
          className={cn(
            "flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2.5 text-foreground shadow-xs transition-colors dark:border-input dark:bg-input/30",
            disabled
              ? "cursor-not-allowed opacity-70"
              : "cursor-pointer hover:bg-muted dark:hover:bg-input/50"
          )}
          htmlFor={switchId}
        >
          <Bell className="size-3.5" />
          <span className="text-sm">Notifications</span>
          <Switch
            aria-label={ariaLabel}
            checked={checked}
            disabled={disabled}
            id={switchId}
            onCheckedChange={handleChange}
            size={size}
          />
        </label>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
