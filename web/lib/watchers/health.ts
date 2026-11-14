// What the Health tab shows about a watcher over a range of days: how each
// 30-minute block of every day is coloured, and the sentences under the four
// count cards. The database read is `getWatcherHealth` in
// `lib/api/watcher-health.ts`; this file has the rules, so they need no
// database to test, and server pages and client components share them.

import { STALE_THRESHOLD_MS } from "@/lib/api/watcher-status";
import { BLOCK_MINUTES } from "./block-edges";
import { describeWithin, pluralize } from "./phrases";
import { describeRange, formatDay, type WatcherRange } from "./range";
import type { RestartReason } from "./stop-reasons";

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
  /**
   * The block holds heartbeats but went quiet for a while that nothing
   * explains (`silenceInBlock`).
   */
  silent?: boolean;
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
 * 4. Checked in (green): it sent a heartbeat, and didn't go quiet for long with
 *    no reason. A heartbeat at a block's edge doesn't hide an outage: a block
 *    that was quiet for the part of a gap the badge would have read
 *    Unresponsive for, with no restart, missed heartbeat or stop to explain it,
 *    is red.
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
    return facts.silent ? { state: "unresponsive" } : { state: "checked_in" };
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

// ---------------------------------------------------------------------------
// Silence between heartbeats
// ---------------------------------------------------------------------------

/**
 * The shortest stretch of unexplained silence that makes a block red, and the
 * slack around the windows that explain it: heartbeats come a minute apart, so
 * less than this is one that came late.
 */
export const SILENCE_TOLERANCE_MS = 60 * 1000;

/** Two consecutive heartbeats at least `STALE_THRESHOLD_MS` apart. */
export interface HeartbeatGap {
  /** The last heartbeat before the gap. */
  from: Date;
  /** The status of the heartbeat before the gap. */
  previousStatus: string;
  /** The first heartbeat after the gap. */
  to: Date;
}

interface Span {
  from: number;
  to: number;
}

/** Whether a stop at `at` is the one a restart window records. */
export function stopIsRestart(
  restarts: RestartWindow[],
  at: Date,
  toleranceMs: number
): boolean {
  return restarts.some(
    (window) => Math.abs(window.from.getTime() - at.getTime()) <= toleranceMs
  );
}

function subtract(spans: Span[], hole: Span): Span[] {
  return spans.flatMap((span) => {
    if (hole.to <= span.from || hole.from >= span.to) {
      return [span];
    }
    const pieces: Span[] = [];
    if (hole.from > span.from) {
      pieces.push({ from: span.from, to: hole.from });
    }
    if (hole.to < span.to) {
      pieces.push({ from: hole.to, to: span.to });
    }
    return pieces;
  });
}

/**
 * The stretches in which a watcher went quiet and nothing says why. In a gap
 * between two heartbeats the watcher reads Unresponsive from
 * `STALE_THRESHOLD_MS` after the first until the second. That is left out
 * where:
 *
 * - the first heartbeat said `stopped` and no restart explains it: someone
 *   stopped the watcher, and a stopped watcher says nothing;
 * - a restart window (the stop until the watcher's next start, or the grace
 *   period) covers it;
 * - a missed-heartbeat window does: the watcher itself reported that gap.
 *
 * What is left, a minute or longer, is an outage nobody explained, such as a
 * power cut that wrote no stop event.
 */
export function unexplainedSilences(
  gaps: HeartbeatGap[],
  restarts: RestartWindow[],
  missed: MissedWindow[],
  stopMatchMs: number
): { from: Date; to: Date }[] {
  const silences: { from: Date; to: Date }[] = [];
  for (const gap of gaps) {
    const quietFrom = gap.from.getTime() + STALE_THRESHOLD_MS;
    const quietTo = gap.to.getTime();
    if (quietTo - quietFrom <= 0) {
      continue;
    }
    if (
      gap.previousStatus === "stopped" &&
      !stopIsRestart(restarts, gap.from, stopMatchMs)
    ) {
      continue;
    }
    let spans: Span[] = [{ from: quietFrom, to: quietTo }];
    for (const window of restarts) {
      spans = subtract(spans, {
        from: window.from.getTime(),
        to: window.to.getTime(),
      });
    }
    for (const window of missed) {
      spans = subtract(spans, {
        from: window.from.getTime() - SILENCE_TOLERANCE_MS,
        to: window.to.getTime() + SILENCE_TOLERANCE_MS,
      });
    }
    for (const span of spans) {
      if (span.to - span.from >= SILENCE_TOLERANCE_MS) {
        silences.push({ from: new Date(span.from), to: new Date(span.to) });
      }
    }
  }
  return silences;
}

/** Whether a block holds at least `SILENCE_TOLERANCE_MS` of unexplained silence. */
export function silenceInBlock(
  silences: { from: Date; to: Date }[],
  block: { start: Date; end: Date }
): boolean {
  return silences.some(
    (silence) =>
      Math.min(silence.to.getTime(), block.end.getTime()) -
        Math.max(silence.from.getTime(), block.start.getTime()) >=
      SILENCE_TOLERANCE_MS
  );
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

/** Under "Files uploaded": "From 7 runs on Nov 10 and 11", "From 8 runs over 7 days". */
export function filesNote(totals: HealthTotals, words: Words): string {
  if (totals.files === 0) {
    return none(words);
  }
  const days = describeDays(totals.daysWithFiles, words);
  // "on Nov 10 and 11", but "over 7 days": a count of days isn't a date.
  const preposition = totals.daysWithFiles.length > 2 ? "over" : "on";
  return totals.runs > 0
    ? `From ${pluralize(totals.runs, "run")} ${preposition} ${days}`
    : `${preposition === "over" ? "Over" : "On"} ${days}`;
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
