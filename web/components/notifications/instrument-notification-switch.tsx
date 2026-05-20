"use client";

import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useState, useTransition } from "react";
import { toast } from "sonner";

// Composition over a `tooltip` boolean prop: the Tooltip is wrapped here
// so callers don't have to know about the active vs muted copy. Three
// places mount this component — the per-instrument cell in the
// instruments table, the row in the InstrumentHeader's action area, and
// the per-instrument list inside the Notifications settings form — and
// they all want identical behaviour.

export function InstrumentNotificationSwitch({
  instrumentId,
  initialEnabled,
  masterMuted,
  size = "default",
  ariaLabel = "Notify me about new runs on this instrument",
}: {
  instrumentId: string;
  initialEnabled: boolean;
  masterMuted: boolean;
  size?: "sm" | "default";
  ariaLabel?: string;
}) {
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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* The wrapper span keeps the tooltip target hoverable even when
            the switch is disabled — a disabled Radix Switch swallows
            pointer events otherwise. */}
        <span className="inline-flex">
          <Switch
            size={size}
            checked={enabled && !masterMuted}
            onCheckedChange={handleChange}
            disabled={masterMuted || isPending}
            aria-label={ariaLabel}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {masterMuted
          ? "All instrument notifications muted in Settings"
          : enabled
            ? "Notifying you about new runs on this instrument"
            : "Click to be notified about new runs on this instrument"}
      </TooltipContent>
    </Tooltip>
  );
}
