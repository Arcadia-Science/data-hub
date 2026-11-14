// What the Health tab shows about a watcher over a range of days: how each
// 30-minute block of every day is coloured, and the sentences under the four
// count cards. The database read is `getWatcherHealth` in
// `lib/api/watcher-health.ts`; this file has the rules, so they need no
// database to test, and server pages and client components share them.

import { STALE_THRESHOLD_MS } from "@/lib/api/watcher-status";
import { describeWithin, pluralize } from "./phrases";
import { describeRange, formatDay, type WatcherRange } from "./range";
import type { RestartReason } from "./stop-reasons";

export const BLOCK_MINUTES = 30;
export const BLOCKS_PER_DAY = 48;
const BLOCK_MS = BLOCK_MINUTES * 60 * 1000;

/**
 * How long a watcher that stopped for an update or a Windows restart has to come
 * back before it reads as unresponsive. The same wait as the badge's: a restart
 * is Restarting for this long, then Unresponsive
 * (`UPLOAD_REQUEST_REVERT_GRACE_MS`).
 */
export const RESTART_GRACE_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/** The five colours of the connectivity grid. */
export type BlockState =
  | "checked_in"
  | "restarted"
  | "missed"
  | "unresponsive"
  | "no_data";

/** Why a block holds no data, for its tooltip. */
export type NoDataReason =
  | "future"
  | "before_first_check_in"
  | "after_deregistered"
  | "stopped"
  | "too_soon";

/** A stop for a restart: from the stop to when the watcher is expected back. */
export interface RestartWindow {
  /** The stop. */
  from: Date;
  reason: RestartReason;
  /** The watcher's next start, if it has started again. */
  resumedAt: Date | null;
  /** The end of the window: the next start, or the grace period, if sooner. */
  to: Date;
}

/** A gap with no heartbeats that ended when the watcher checked in again. */
export interface MissedWindow {
  /** When the watcher's heartbeats failed first. */
  from: Date;
  gapSeconds: number;
  recoveredAt: Date;
  /** When the watcher checked in again. */
  to: Date;
}

/** Builds a restart's window from its stop and the watcher's next start. */
export function restartWindow(
  stoppedAt: Date,
  reason: RestartReason,
  resumedAt: Date | null
): RestartWindow {
  const graceEnd = new Date(stoppedAt.getTime() + RESTART_GRACE_MS);
  const to =
    resumedAt && resumedAt.getTime() < graceEnd.getTime()
      ? resumedAt
      : graceEnd;
  return { from: stoppedAt, to, reason, resumedAt };
}

/** Builds a missed-heartbeat window from the event that ended it. */
export function missedWindow(
  recoveredAt: Date,
  gapSeconds: number
): MissedWindow {
  return {
    from: new Date(recoveredAt.getTime() - gapSeconds * 1000),
    to: recoveredAt,
    recoveredAt,
    gapSeconds,
  };
}

/**
 * Whether a window belongs to a block. The block that holds the window's start
 * always does, so a restart or a gap of a few minutes colours one block, not
 * two when it straddles a boundary. After that a window colours the blocks it
 * covers that heard nothing, so a long one is not hidden behind a block that
 * happens to hold a heartbeat at its edge.
 */
export function windowTouchesBlock(
  window: { from: Date; to: Date },
  block: { start: Date; end: Date; heartbeats: number }
): boolean {
  const holdsStart =
    window.from.getTime() >= block.start.getTime() &&
    window.from.getTime() < block.end.getTime();
  if (holdsStart) {
    return true;
  }
  return (
    block.heartbeats === 0 &&
    window.from.getTime() < block.end.getTime() &&
    window.to.getTime() > block.start.getTime()
  );
}

export interface BlockFacts {
  deregisteredAt: Date | null;
  end: Date;
  /** The first heartbeat the watcher ever sent, or null if it sent none. */
  firstHeartbeatAt: Date | null;
  heartbeats: number;
  /** A missed-heartbeat gap that belongs to this block. */
  missed: boolean;
  now: Date;
  /** A restart that belongs to this block. */
  restarted: boolean;
  start: Date;
  /** The watcher's own last word before this block was `stopped`, for no restart. */
  stoppedBefore: boolean;
}

export interface ClassifiedBlock {
  noData?: NoDataReason;
  state: BlockState;
}

/**
 * The colour of one 30-minute block, from the first rule that fits:
 *
 * 1. No data: it hasn't happened yet, the watcher hadn't checked in yet or was
 *    already deregistered, or it is too early in the block to say it was quiet.
 * 2. Restarted (gray): the watcher stopped for an update or a Windows restart.
 * 3. Missed a heartbeat (amber): a gap that recovered.
 * 4. Checked in (green): it sent a heartbeat.
 * 5. No data again when someone stopped it: a stopped watcher says nothing.
 * 6. Unresponsive (red): it should have checked in and didn't.
 */
export function classifyBlock(facts: BlockFacts): ClassifiedBlock {
  const { start, end, now } = facts;
  if (start.getTime() >= now.getTime()) {
    return { state: "no_data", noData: "future" };
  }
  if (end.getTime() <= start.getTime()) {
    // A block that doesn't exist: a clock change skipped it.
    return { state: "no_data", noData: "too_soon" };
  }
  if (
    !facts.firstHeartbeatAt ||
    end.getTime() <= facts.firstHeartbeatAt.getTime()
  ) {
    return { state: "no_data", noData: "before_first_check_in" };
  }
  if (
    facts.deregisteredAt &&
    start.getTime() >= facts.deregisteredAt.getTime()
  ) {
    return { state: "no_data", noData: "after_deregistered" };
  }
  if (facts.restarted) {
    return { state: "restarted" };
  }
  if (facts.missed) {
    return { state: "missed" };
  }
  if (facts.heartbeats > 0) {
    return { state: "checked_in" };
  }
  if (facts.stoppedBefore) {
    return { state: "no_data", noData: "stopped" };
  }
  // Quiet for part of a block that is still going, or that the watcher's life
  // began or ended in the middle of, is quiet for less than the 5 minutes that
  // make a watcher unresponsive.
  const from = Math.max(start.getTime(), facts.firstHeartbeatAt.getTime());
  const until = Math.min(
    end.getTime(),
    now.getTime(),
    facts.deregisteredAt?.getTime() ?? Number.POSITIVE_INFINITY
  );
  if (until - from < STALE_THRESHOLD_MS) {
    return { state: "no_data", noData: "too_soon" };
  }
  return { state: "unresponsive" };
}

/** The start of the block at `slot` (0 to 47) of a day that starts at `dayStart`. */
export function blockStart(dayStart: Date, slot: number): Date {
  return new Date(dayStart.getTime() + slot * BLOCK_MS);
}

// ---------------------------------------------------------------------------
// What the read returns
// ---------------------------------------------------------------------------

export interface HealthBlock extends ClassifiedBlock {
  /** Heartbeats in the block. */
  heartbeats: number;
  missed?: { gapSeconds: number; recoveredAt: Date };
  restart?: { reason: RestartReason; stoppedAt: Date; resumedAt: Date | null };
}

export interface HealthDay {
  /** Always 48 blocks, midnight first, in the viewer's time zone. */
  blocks: HealthBlock[];
  /** The calendar day, `yyyy-MM-dd`. */
  date: string;
  /** Files uploaded that day. */
  files: number;
}

export interface HealthTotals {
  /** Days that had uploads, oldest first. */
  daysWithFiles: string[];
  /** Files uploaded. */
  files: number;
  /** The longest gap that recovered, in seconds. */
  longestMissedSeconds: number;
  /** Heartbeat gaps that recovered. */
  missedHeartbeats: number;
  restarts: Record<RestartReason, number>;
  /** Distinct runs the uploaded files belong to. */
  runs: number;
  uploadFailures: number;
}

export interface WatcherHealth {
  days: HealthDay[];
  totals: HealthTotals;
}

// ---------------------------------------------------------------------------
// The sentences under the count cards
// ---------------------------------------------------------------------------

type RangeWords = Pick<WatcherRange, "fromDay" | "toDay" | "dayCount">;

interface Words {
  now: Date;
  range: RangeWords;
  timeZone: string;
}

function none(words: Words): string {
  return `None ${describeRange(words.range, words.timeZone, words.now)}`;
}

/** "Nov 10", "Nov 10 and 11", "Nov 30 and Dec 1", "4 days". */
function describeDays(days: string[], words: Words): string {
  const { now, timeZone } = words;
  if (days.length === 1) {
    return formatDay(days[0], now, timeZone);
  }
  if (days.length === 2) {
    const [first, second] = days;
    const sameMonth = first.slice(0, 7) === second.slice(0, 7);
    // "Nov 10 and 11", but "Oct 31 and Nov 1".
    return sameMonth
      ? `${formatDay(first, now, timeZone)} and ${Number(second.slice(8))}`
      : `${formatDay(first, now, timeZone)} and ${formatDay(second, now, timeZone)}`;
  }
  return `${days.length} days`;
}

/** Under "Files uploaded": "From 7 runs on Nov 10 and 11". */
export function filesNote(totals: HealthTotals, words: Words): string {
  if (totals.files === 0) {
    return none(words);
  }
  const days = describeDays(totals.daysWithFiles, words);
  return totals.runs > 0
    ? `From ${pluralize(totals.runs, "run")} on ${days}`
    : `On ${days}`;
}

const RESTART_PHRASES: Record<RestartReason, { one: string; many: string }> = {
  update: { one: "an automatic update", many: "automatic updates" },
  windows: { one: "a Windows restart", many: "Windows restarts" },
};

/** Under "Restarts": "All for automatic updates". */
export function restartsNote(
  restarts: Record<RestartReason, number>,
  words: Words
): string {
  const reasons = (Object.keys(RESTART_PHRASES) as RestartReason[]).filter(
    (reason) => restarts[reason] > 0
  );
  if (reasons.length === 0) {
    return none(words);
  }
  if (reasons.length === 1) {
    const [reason] = reasons;
    const count = restarts[reason];
    return count === 1
      ? `For ${RESTART_PHRASES[reason].one}`
      : `All for ${RESTART_PHRASES[reason].many}`;
  }
  return reasons
    .map((reason) => {
      const count = restarts[reason];
      const phrase = RESTART_PHRASES[reason];
      return `${count} for ${count === 1 ? phrase.one : phrase.many}`;
    })
    .join(", ");
}

/** Under "Missed heartbeats": "Each recovered within a minute". */
export function missedNote(totals: HealthTotals, words: Words): string {
  if (totals.missedHeartbeats === 0) {
    return none(words);
  }
  const within = `within ${describeWithin(totals.longestMissedSeconds)}`;
  return totals.missedHeartbeats === 1
    ? `Recovered ${within}`
    : `Each recovered ${within}`;
}

/** Under "Upload failures": "None in the last 7 days", or nothing to say. */
export function failuresNote(failures: number, words: Words): string | null {
  return failures === 0 ? none(words) : null;
}

/** A block's start as a wall-clock time: slot 19 is "9:30 AM", slot 48 is "12:00 AM". */
export function blockTimeLabel(slot: number): string {
  const minutes = slot * BLOCK_MINUTES;
  const hour24 = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const suffix = hour24 < 12 ? "AM" : "PM";
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}
