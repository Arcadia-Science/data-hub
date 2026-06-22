import { eq, isNull, sql } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/lib/db";
import { instrumentRuns, instruments, watchers } from "@/lib/db/schema";

export interface SidebarInstrument {
  displayName: string;
  id: string;
}

export interface SidebarWatcher {
  hostname: string | null;
  id: string;
}

// Cap the sidebar lists so the nav stays scannable even on workspaces with
// many instruments/watchers. The "View all" sub-item links to the full page.
const SIDEBAR_LIST_LIMIT = 4;

// Trimmed query for the navigation sidebar: the most recently active
// instruments only. "Activity" = the timestamp of the latest run, with a
// `nulls last` ordering so instruments that have never run sink to the
// bottom rather than starving more useful entries off the list.
//
// Wrapped in `cache()` so the layout and any descendants share a single
// result per request.
export const getSidebarInstruments = cache(
  async function getSidebarInstruments(): Promise<SidebarInstrument[]> {
    const lastRunSq = db
      .select({
        instrumentId: instrumentRuns.instrumentId,
        lastRunAt:
          sql<Date | null>`max(coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt}))`.as(
            "last_run_at"
          ),
      })
      .from(instrumentRuns)
      .where(isNull(instrumentRuns.deletedAt))
      .groupBy(instrumentRuns.instrumentId)
      .as("last_run");

    return db
      .select({
        id: instruments.id,
        displayName: instruments.displayName,
      })
      .from(instruments)
      .leftJoin(lastRunSq, eq(lastRunSq.instrumentId, instruments.id))
      .where(eq(instruments.status, "active"))
      .orderBy(sql`${lastRunSq.lastRunAt} desc nulls last`)
      .limit(SIDEBAR_LIST_LIMIT);
  }
);

// Most recently heartbeating non-deregistered watchers. `nulls last` so
// freshly-registered watchers that haven't sent a heartbeat yet don't
// dominate the top of the list.
export const getSidebarWatchers = cache(
  async function getSidebarWatchers(): Promise<SidebarWatcher[]> {
    return db
      .select({
        id: watchers.id,
        hostname: watchers.hostname,
      })
      .from(watchers)
      .where(isNull(watchers.deletedAt))
      .orderBy(sql`${watchers.lastHeartbeatAt} desc nulls last`)
      .limit(SIDEBAR_LIST_LIMIT);
  }
);
