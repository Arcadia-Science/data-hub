// Which of an instrument's watcher registrations its watcher page shows, and
// whether the page offers a switcher between them. No database imports, so the
// server pages and the client switcher share one definition.
//
// An instrument has at most one active registration and any number of past
// (deregistered) ones. A reinstall creates a new registration, so the past ones
// keep their own events, heartbeats and settings history.

import { formatDateCompact } from "@/lib/date";

/** One row of the `watchers` table for an instrument. */
export interface WatcherRegistration {
  createdAt: Date;
  /** Null while the registration is the instrument's current one. */
  deletedAt: Date | null;
  /** Who deregistered it: a person or a token name. Null when not recorded. */
  deregisteredByName: string | null;
  hostname: string | null;
  id: string;
}

/** Newest first. The input is left as it was. */
export function sortRegistrations(
  registrations: readonly WatcherRegistration[]
): WatcherRegistration[] {
  return [...registrations].sort(
    (a, b) =>
      b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)
  );
}

export interface WatcherSelection {
  /** The instrument's active registration, or null when it has none. */
  current: WatcherRegistration | null;
  /** Past registrations show read-only, with a notice. */
  isPast: boolean;
  /** Newest first. */
  registrations: WatcherRegistration[];
  /**
   * True when the URL named the registration with `?watcher=`. The sub-tab
   * links then keep the parameter, whichever registration it names.
   */
  requested: boolean;
  /**
   * The registration the page shows. Null when the instrument has never had
   * one, which the page answers with an empty state.
   */
  selected: WatcherRegistration | null;
  /** The switcher shows only when there is more than one registration. */
  showSwitcher: boolean;
}

/**
 * Decides what `/instruments/<id>/watcher` shows:
 *
 * | Registrations            | Switcher | Opens on                         |
 * | ------------------------ | -------- | -------------------------------- |
 * | 1 active, 0 past         | hidden   | the current watcher              |
 * | 1 active, 1 or more past | shown    | the current watcher              |
 * | 0 active, 1 past         | hidden   | that past watcher, with a notice |
 * | 0 active, 2 or more past | shown    | the most recent past watcher     |
 * | none                     | hidden   | an empty state                   |
 *
 * `requestedId` is the `?watcher=` value. A registration of this instrument
 * opens as asked. Anything else, including a UUID that belongs to another
 * instrument, returns null, which the page answers with not found. Only this
 * instrument's registrations are compared, so the page never reads another
 * instrument's watcher.
 */
export function selectWatcherRegistration(
  registrations: readonly WatcherRegistration[],
  requestedId: string | null
): WatcherSelection | null {
  const sorted = sortRegistrations(registrations);
  const current = sorted.find((r) => r.deletedAt === null) ?? null;
  const showSwitcher = sorted.length > 1;

  let selected: WatcherRegistration | null;
  if (requestedId) {
    const wanted = requestedId.toLowerCase();
    selected = sorted.find((r) => r.id.toLowerCase() === wanted) ?? null;
    if (!selected) {
      return null;
    }
  } else {
    // Sorted newest first, so the first past one is the most recent.
    selected = current ?? sorted[0] ?? null;
  }

  return {
    registrations: sorted,
    current,
    requested: Boolean(requestedId),
    selected,
    isPast: selected !== null && selected.deletedAt !== null,
    showSwitcher,
  };
}

/** What a switcher option says about a registration, under its computer name. */
export interface RegistrationSummary {
  /** The line under the computer name. */
  detail: string;
  /** "Current" for the instrument's active registration. */
  tag: "Current" | null;
}

/**
 * "Current · since {date}", or "{start} to {end} · deregistered by {name}".
 * Dates are in `timeZone`, the viewer's.
 */
export function summarizeRegistration(
  registration: WatcherRegistration,
  timeZone: string,
  now: Date = new Date()
): RegistrationSummary {
  const start = formatDateCompact(registration.createdAt, timeZone, now);
  if (registration.deletedAt === null) {
    return { tag: "Current", detail: `Since ${start}` };
  }
  const end = formatDateCompact(registration.deletedAt, timeZone, now);
  const by = registration.deregisteredByName;
  return {
    tag: null,
    detail: `${start} to ${end}${by ? ` · deregistered by ${by}` : ""}`,
  };
}

/** "It was deregistered on {date} by {name}." with the name when it is known. */
export function describeDeregistration(
  registration: Pick<WatcherRegistration, "deletedAt" | "deregisteredByName">,
  timeZone: string,
  now: Date = new Date()
): string {
  const by = registration.deregisteredByName;
  if (registration.deletedAt === null) {
    return "";
  }
  const date = formatDateCompact(registration.deletedAt, timeZone, now);
  return `It was deregistered on ${date}${by ? ` by ${by}` : ""}.`;
}
