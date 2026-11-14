"use client";

import Link from "next/link";
import {
  INSTRUMENT_BADGE_CONFIG,
  INSTRUMENT_BADGE_TOOLTIP_HINT,
  instrumentBadgeSentence,
} from "@/components/instruments/instrument-badge-config";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  type Connection,
  type InstrumentBadgeState,
  type InstrumentLifecycleStatus,
  instrumentBadgeState,
  type UploadMode,
} from "@/lib/instruments/connection";
import { cn } from "@/lib/utils";
import { watcherPageHref } from "@/lib/watchers/routes";

/**
 * The badge's look without its link or tooltip. It is for a place that is
 * already inside a link, such as a search result, where a second link would nest
 * one `<a>` in another, and for text that only names a state. Everything else
 * uses `InstrumentBadge`.
 */
export function InstrumentBadgePill({
  state,
  className,
}: {
  state: InstrumentBadgeState;
  className?: string;
}) {
  const {
    label,
    Icon,
    className: stateClassName,
  } = INSTRUMENT_BADGE_CONFIG[state];
  return (
    <Badge className={cn(stateClassName, className)}>
      <Icon aria-hidden="true" />
      {label}
    </Badge>
  );
}

/**
 * The status pill next to an instrument's name, in the instruments table, on
 * the dashboard and in the header. It answers one question: will my new files
 * show up? The state comes from `instrumentBadgeState`, so Pending and Retired
 * win over the connection.
 *
 * It links to the instrument's watcher page. On hover or keyboard focus a
 * tooltip gives the state's name in bold, one sentence, and where the link
 * goes. In a table row, put it inside `RowControl` so its link sits above the
 * row's own.
 */
export function InstrumentBadge({
  instrumentId,
  status,
  connection,
  uploadMode = "auto",
  className,
}: {
  instrumentId: string;
  status: InstrumentLifecycleStatus;
  connection: Connection;
  /** The watcher's upload mode. It changes what Online says. */
  uploadMode?: UploadMode;
  className?: string;
}) {
  const state = instrumentBadgeState(status, connection);
  const { label } = INSTRUMENT_BADGE_CONFIG[state];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          aria-label={`${label}, watcher details`}
          className="inline-flex rounded-4xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
          href={watcherPageHref(instrumentId)}
        >
          <InstrumentBadgePill className={className} state={state} />
        </Link>
      </TooltipTrigger>
      <TooltipContent className="flex flex-col items-start gap-1" side="bottom">
        <p className="font-semibold">{label}</p>
        <p>{instrumentBadgeSentence(state, uploadMode)}</p>
        <p className="text-background/70">{INSTRUMENT_BADGE_TOOLTIP_HINT}</p>
      </TooltipContent>
    </Tooltip>
  );
}
