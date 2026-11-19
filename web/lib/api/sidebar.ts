import { and, eq, isNull, sql } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/lib/db";
import {
  instrumentRuns,
  instruments,
  notebooks,
  runNotebookLinks,
} from "@/lib/db/schema";

export interface SidebarInstrument {
  displayName: string;
  id: string;
}

export interface SidebarNotebook {
  id: string;
  name: string;
}

// Cap the sidebar list so the nav stays scannable even on workspaces with
// many instruments. The "View all" sub-item links to the full page.
const SIDEBAR_LIST_LIMIT = 5;

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

    return await db
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

// The notebooks that most recently got a run, for the sidebar's Notebooks
// section, which lists the viewer's recently viewed notebooks first and fills
// the rest from here. "Got a run" is when a live run was added, so a notebook
// with no live runs, or a deleted notebook, isn't listed. Five is enough:
// with k recently viewed notebooks shown, at most k of these repeat one, which
// leaves the 5 - k the section still has room for.
//
// Wrapped in `cache()` like `getSidebarInstruments`.
export const getSidebarNotebooks = cache(
  async function getSidebarNotebooks(): Promise<SidebarNotebook[]> {
    const lastAdded = sql`max(${runNotebookLinks.createdAt})`;
    return await db
      .select({ id: notebooks.id, name: notebooks.name })
      .from(notebooks)
      .innerJoin(
        runNotebookLinks,
        eq(runNotebookLinks.notebookId, notebooks.id)
      )
      .innerJoin(
        instrumentRuns,
        and(
          eq(instrumentRuns.id, runNotebookLinks.runId),
          isNull(instrumentRuns.deletedAt)
        )
      )
      .where(isNull(notebooks.deletedAt))
      .groupBy(notebooks.id, notebooks.name)
      .orderBy(sql`${lastAdded} desc`, notebooks.id)
      .limit(SIDEBAR_LIST_LIMIT);
  }
);
