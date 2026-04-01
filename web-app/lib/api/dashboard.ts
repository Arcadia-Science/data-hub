import { db } from "@/lib/db";
import { files, instrumentRuns, instruments, watchers } from "@/lib/db/schema";
import { eq, isNull, sql } from "drizzle-orm";

export type InstrumentSummary = {
  id: string;
  displayName: string;
  status: "pending" | "active" | "inactive";
  runCount: number;
  lastRunAt: Date | null;
  watcherStatus: "online" | "offline" | "no_watcher";
  filesPendingUpload: number;
};

// A watcher is considered stale (offline) if it hasn't sent a heartbeat
// within this window, even if its DB status is still "watching".
const HEARTBEAT_STALE_MINUTES = 5;

export async function getInstrumentSummaries(): Promise<InstrumentSummary[]> {
  // Instrument stats and watcher liveness are fetched separately to avoid a
  // combinatorial explosion from joining instruments × runs × files × watchers
  // in a single query. The watcher lookup is lightweight (one row per agent).
  const rows = await db
    .select({
      id: instruments.id,
      displayName: instruments.displayName,
      status: instruments.status,
      runCount: sql<number>`cast(count(distinct ${instrumentRuns.id}) filter (where ${instrumentRuns.deletedAt} is null) as int)`,
      lastRunAt: sql<Date | null>`max(${instrumentRuns.createdAt}) filter (where ${instrumentRuns.deletedAt} is null)`,
      filesPendingUpload: sql<number>`cast(count(distinct ${files.id}) filter (where ${files.status} in ('detected', 'upload_requested') and ${files.deletedAt} is null) as int)`,
    })
    .from(instruments)
    .leftJoin(instrumentRuns, eq(instrumentRuns.instrumentId, instruments.id))
    .leftJoin(files, eq(files.instrumentRunId, instrumentRuns.id))
    .groupBy(instruments.id, instruments.displayName, instruments.status)
    .orderBy(instruments.displayName);

  const watcherRows = await db
    .select({
      instrumentId: watchers.instrumentId,
      status: watchers.status,
      lastHeartbeatAt: watchers.lastHeartbeatAt,
    })
    .from(watchers)
    .where(isNull(watchers.deletedAt));

  // Index watchers by instrument so we can do O(1) lookups when enriching rows.
  const watcherMap = new Map<
    string,
    { status: string; lastHeartbeatAt: Date | null }[]
  >();
  for (const w of watcherRows) {
    const arr = watcherMap.get(w.instrumentId) ?? [];
    arr.push(w);
    watcherMap.set(w.instrumentId, arr);
  }

  const staleThreshold = new Date(
    Date.now() - HEARTBEAT_STALE_MINUTES * 60 * 1000
  );

  return rows.map((row) => {
    const instrumentWatchers = watcherMap.get(row.id) ?? [];
    let watcherStatus: InstrumentSummary["watcherStatus"] = "no_watcher";

    // An instrument is "online" only if at least one watcher is actively
    // heartbeating. Registered watchers that have gone silent are "offline".
    if (instrumentWatchers.length > 0) {
      const hasOnline = instrumentWatchers.some(
        (w) =>
          w.status === "watching" &&
          w.lastHeartbeatAt &&
          w.lastHeartbeatAt > staleThreshold
      );
      watcherStatus = hasOnline ? "online" : "offline";
    }

    return {
      id: row.id,
      displayName: row.displayName,
      status: row.status,
      runCount: row.runCount,
      lastRunAt: row.lastRunAt,
      filesPendingUpload: row.filesPendingUpload,
      watcherStatus,
    };
  });
}

export async function getInstruments() {
  return db
    .select({
      id: instruments.id,
      displayName: instruments.displayName,
      status: instruments.status,
    })
    .from(instruments)
    .orderBy(instruments.displayName);
}
