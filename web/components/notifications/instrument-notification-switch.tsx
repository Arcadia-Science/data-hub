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

// Composition over a `tooltip` boolean prop: the Tooltip is wrapped here
// so callers don't have to know about the active vs muted copy. Four
// places mount this component — the per-instrument cell in the
// instruments table, the per-instrument list inside the Notifications
// settings form (both `switch` variant), and the instrument-detail header
// (`button` variant, a labelled pill) — and they all want identical
// behaviour.

export function InstrumentNotificationSwitch({
  instrumentId,
  initialEnabled,
  masterMuted,
  size = "default",
  variant = "switch",
  ariaLabel = "Notify me about new runs on this instrument",
}: {
  instrumentId: string;
  initialEnabled: boolean;
  masterMuted: boolean;
  size?: "sm" | "default";
  /**
   * `switch` renders a bare toggle (table cell, settings list). `button`
   * renders a labelled pill — a bell icon, "Notifications", and the toggle —
   * where the *entire* pill is clickable and hover shows the tooltip.
   */
  variant?: "switch" | "button";
  ariaLabel?: string;
}) {
  const switchId = useId();
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
  const disabled = masterMuted || isPending;

  const tooltip = masterMuted
    ? "All instrument notifications muted in Settings"
    : enabled
      ? "Notifying you about new runs on this instrument"
      : "Click to be notified about new runs on this instrument";

  const control = (
    <Switch
      aria-label={ariaLabel}
      checked={enabled && !masterMuted}
      disabled={disabled}
      id={switchId}
      onCheckedChange={handleChange}
      size={size}
    />
  );

  if (variant === "button") {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* The whole pill is the toggle: it's a `<label>` bound to the
              switch, so clicking anywhere on it flips the control, and the
              tooltip fires on hover over the entire area rather than just the
              toggle. The bell + text are phrasing content; the switch is the
              label's single labelable control, so the markup stays valid. */}
          <label
            className={cn(
              "flex h-8 items-center gap-2 rounded-md border bg-background px-2.5 shadow-xs transition-colors",
              disabled
                ? "cursor-not-allowed opacity-70"
                : "cursor-pointer hover:bg-muted"
            )}
            htmlFor={switchId}
          >
            <Bell className="size-3.5 text-muted-foreground" />
            <span className="text-sm">Notifications</span>
            {control}
          </label>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* The wrapper span keeps the tooltip target hoverable even when
            the switch is disabled — a disabled Radix Switch swallows
            pointer events otherwise. */}
        <span className="inline-flex">{control}</span>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
