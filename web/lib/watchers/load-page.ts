// What every page of `/instruments/<id>/watcher` needs before it renders: the
// instrument, its watcher registrations, and the one the visitor is looking at.
// Server only, because it reads the database.

import { notFound, redirect } from "next/navigation";
import {
  getInstrumentById,
  type InstrumentDetail,
} from "@/lib/api/instruments";
import { listWatcherRegistrations } from "@/lib/api/watcher-registrations";
import { getLatestWatcherVersion } from "@/lib/api/watcher-release";
import { getWatcherById, type WatcherDetail } from "@/lib/api/watchers";
import { auth, type Session } from "@/lib/auth";
import { loginHref } from "@/lib/callback-url";
import type { SharedComputerInstrument } from "@/lib/instruments/connection";
import { getRequestPath } from "@/lib/request-path";
import {
  selectWatcherRegistration,
  type WatcherSelection,
} from "@/lib/watchers/registrations";

/**
 * The signed-in session, or a redirect to sign-in that returns to the same URL,
 * query included. The proxy sends signed-out visitors to sign-in first, since
 * `/instruments` is public for link previews. This guard is for a session the
 * proxy can't tell is expired: it only checks that a cookie exists.
 */
export async function requireWatcherPageSession(): Promise<Session> {
  const session = await auth();
  if (!session) {
    redirect(loginHref(await getRequestPath()));
  }
  return session;
}

export interface WatcherPageData {
  instrument: InstrumentDetail;
  /** The latest version on the release form, or null when none is set. */
  latestVersion: string | null;
  selection: WatcherSelection;
  /**
   * Other instruments whose active watcher runs on this computer. Only an
   * active watcher has any: a past watcher's computer isn't affected by it.
   */
  sharedComputerWith: SharedComputerInstrument[];
  /** The selected registration's row, or null when the instrument has none. */
  watcher: WatcherDetail | null;
}

/** A query parameter's value: the first one when repeated, null when empty. */
export function firstQueryValue(
  value: string | string[] | undefined
): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first ? first : null;
}

/**
 * Loads the watcher page for an instrument. Calls `notFound()` for an
 * instrument that doesn't exist and for a `?watcher=` that isn't one of its
 * registrations. Call it before any Suspense boundary, so the response is a
 * real 404.
 */
export async function loadWatcherPage(
  instrumentId: string,
  watcherParam: string | string[] | undefined
): Promise<WatcherPageData> {
  const [instrument, registrations, latestVersion] = await Promise.all([
    getInstrumentById(instrumentId),
    listWatcherRegistrations(instrumentId),
    getLatestWatcherVersion(),
  ]);
  if (!instrument) {
    notFound();
  }

  const selection = selectWatcherRegistration(
    registrations,
    firstQueryValue(watcherParam)
  );
  if (!selection) {
    notFound();
  }

  let watcher: WatcherDetail | null = null;
  if (selection.selected) {
    watcher = await getWatcherById(selection.selected.id);
    // The row was there a moment ago and is gone: nothing left to show.
    if (!watcher) {
      notFound();
    }
  }

  return {
    instrument,
    latestVersion,
    selection,
    watcher,
    sharedComputerWith: selection.isPast
      ? []
      : (instrument.watcher?.sharedComputerWith ?? []),
  };
}
