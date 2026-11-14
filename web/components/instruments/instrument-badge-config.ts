import {
  Clock,
  type LucideIcon,
  Power,
  Radio,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import type {
  InstrumentBadgeState,
  UploadMode,
} from "@/lib/instruments/connection";

/**
 * What each state of the instrument badge looks like and says, kept apart from
 * the component so a test can read it without rendering. The labels, icons and
 * colors are the design's badge board; the sentences are the copy deck's.
 *
 * Colors follow the watcher badge: a light fill in light mode and a dark one in
 * dark mode, from the same green, red, slate and amber families.
 */
export interface InstrumentBadgeConfig {
  className: string;
  Icon: LucideIcon;
  label: string;
}

export const INSTRUMENT_BADGE_CONFIG: Record<
  InstrumentBadgeState,
  InstrumentBadgeConfig
> = {
  online: {
    label: "Online",
    Icon: Radio,
    className:
      "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
  },
  restarting: {
    label: "Restarting",
    Icon: RefreshCw,
    className:
      "bg-slate-100 text-slate-700 dark:bg-slate-950 dark:text-slate-300",
  },
  connecting: {
    label: "Connecting",
    Icon: Clock,
    className:
      "bg-slate-100 text-slate-700 dark:bg-slate-950 dark:text-slate-300",
  },
  offline: {
    label: "Offline",
    Icon: WifiOff,
    className: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  },
  pending: {
    label: "Pending",
    Icon: Clock,
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  },
  retired: {
    label: "Retired",
    Icon: Power,
    className:
      "bg-slate-600 text-slate-50 dark:bg-slate-700 dark:text-slate-100",
  },
};

const TOOLTIP_SENTENCES: Record<InstrumentBadgeState, string> = {
  online: "New files upload automatically.",
  restarting:
    "The instrument PC is restarting or updating. This usually takes a minute or two.",
  connecting: "The watcher was just set up and hasn't checked in yet.",
  offline: "New files won't appear right now.",
  pending: "Waiting for an admin to confirm this instrument.",
  retired: "This instrument no longer takes new runs. Its runs stay browsable.",
};

const MANUAL_ONLINE_SENTENCE = "New files upload when someone requests them.";

/**
 * The sentence under the state name in the badge's tooltip. Only Online reads
 * differently in manual upload mode: a manual watcher is working when it is
 * online, but it uploads only the files someone asks for.
 */
export function instrumentBadgeSentence(
  state: InstrumentBadgeState,
  uploadMode: UploadMode = "auto"
): string {
  if (state === "online" && uploadMode === "manual") {
    return MANUAL_ONLINE_SENTENCE;
  }
  return TOOLTIP_SENTENCES[state];
}

/** The line that ends every tooltip. */
export const INSTRUMENT_BADGE_TOOLTIP_HINT = "Click for watcher details.";
