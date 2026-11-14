// What a block of the connectivity grid says about itself: a title, and a line
// or two about what happened and when. The tooltip shows it, and a screen reader
// hears it as the block's name. No database imports, so client components share
// it, and it needs no browser to test.

import { formatTime } from "@/lib/date";
import { BLOCK_MINUTES } from "./block-edges";
import { blockTimeLabel, type HealthBlock, type NoDataReason } from "./health";
import { describeDuration } from "./phrases";

export interface BlockText {
  /** What happened, if the title doesn't say it all. */
  detail: string | null;
  /** "Checked in", "Missed a heartbeat". */
  title: string;
  /** The block's day and time: "Sat, Nov 7, 9:30 AM to 10:00 AM". */
  when: string;
}

const NO_DATA_DETAILS: Record<NoDataReason, string> = {
  future: "This part of the day hasn't happened yet.",
  before_first_check_in: "The watcher hadn't checked in yet.",
  after_deregistered: "The watcher had been deregistered.",
  stopped: "The watcher was stopped, so it sent nothing.",
  too_soon: "Too soon to tell.",
};

/**
 * The 30 minutes a block covers, on the viewer's wall clock. `dayLabel` is the
 * day's `longDayLabel`, which the caller makes once for the day's 48 blocks.
 */
export function blockWhen(dayLabel: string, slot: number): string {
  return `${dayLabel}, ${blockTimeLabel(slot)} to ${blockTimeLabel(slot + 1)}`;
}

function restartDetail(
  restart: NonNullable<HealthBlock["restart"]>,
  timeZone: string
): string {
  const stopped = `Stopped at ${formatTime(restart.stoppedAt, timeZone)}`;
  return restart.resumedAt
    ? `${stopped}, started again at ${formatTime(restart.resumedAt, timeZone)}.`
    : `${stopped}.`;
}

/** The title, the time and the detail of a block. `when` is from `blockWhen`. */
export function describeBlock(
  block: HealthBlock,
  when: string,
  timeZone: string
): BlockText {
  switch (block.state) {
    case "checked_in":
      return {
        title: "Checked in",
        when,
        detail: `${block.heartbeats} ${block.heartbeats === 1 ? "heartbeat" : "heartbeats"} in these ${BLOCK_MINUTES} minutes.`,
      };
    case "restarted":
      return {
        title:
          block.restart?.reason === "windows"
            ? "Restarted with Windows"
            : "Restarted for an update",
        when,
        detail: block.restart ? restartDetail(block.restart, timeZone) : null,
      };
    case "missed":
      return {
        title: "Missed a heartbeat",
        when,
        detail: block.missed
          ? `Out of contact for ${describeDuration(block.missed.gapSeconds)}, checked in again at ${formatTime(block.missed.recoveredAt, timeZone)}.`
          : null,
      };
    case "unresponsive":
      return {
        title: "Unresponsive",
        when,
        detail:
          block.heartbeats > 0
            ? "The watcher went quiet for part of these 30 minutes."
            : "The watcher didn't check in during these 30 minutes.",
      };
    case "no_data":
      return {
        title: "No data",
        when,
        detail: block.noData ? NO_DATA_DETAILS[block.noData] : null,
      };
    default:
      return block.state satisfies never;
  }
}

/** The block as one sentence, for a screen reader. */
export function blockSentence(text: BlockText): string {
  return [text.title, text.when, text.detail].filter(Boolean).join(". ");
}
