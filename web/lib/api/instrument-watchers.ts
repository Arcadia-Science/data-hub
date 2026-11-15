// Reads the one active watcher of each instrument, and everything instrument
// responses say about it: the `watcher` object, the `connection`, and how many
// past (deregistered) watchers the instrument has. The web app, REST API and
// MCP tools all build their instrument responses from here, so they agree.
//
// A partial unique index on `watchers` allows one row per instrument where
// `deleted_at` is null, so each read selects that row. Nothing counts or merges
// watchers per instrument.

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { hasScope } from "@/lib/api/scopes";
import { readInstrumentConfigFields } from "@/lib/api/watcher-config/from-yaml";
import {
  currentRevisionStatusSql,
  pcEditAwaitingRestartSql,
} from "@/lib/api/watcher-config/revisions";
import { computeEffectiveStatus } from "@/lib/api/watcher-status";
import { type DbExecutor, db } from "@/lib/db";
import { instruments, watchers } from "@/lib/db/schema";
import {
  type Connection,
  type ConnectionWatcher,
  computeConnection,
  deriveConfigState,
  type InstrumentWatcher,
} from "@/lib/instruments/connection";

/** The most recently deregistered watcher of an instrument. */
export interface PastWatcherRef {
  hostname: string | null;
  id: string;
}

export interface InstrumentWatcherInfo {
  connection: Connection;
  /**
   * The most recently deregistered watcher, or null when there is none. A
   * retired instrument's links use it when no watcher is active.
   */
  mostRecentPastWatcher: PastWatcherRef | null;
  /** How many deregistered watchers the instrument has had. */
  pastWatcherCount: number;
  /** The active watcher, or null when the instrument has none. */
  watcher: InstrumentWatcher | null;
}

/** For an instrument that has never had a watcher. */
export const NO_WATCHER_INFO: InstrumentWatcherInfo = {
  watcher: null,
  pastWatcherCount: 0,
  mostRecentPastWatcher: null,
  connection: { state: "offline", reason: "no_watcher" },
};

/**
 * Reads the watcher state of these instruments in at most three queries,
 * however many there are: the active watchers, the past watcher counts, and
 * the other active watchers on the same computers. The map has an entry for
 * every ID asked for.
 */
export async function getInstrumentWatcherInfo(
  instrumentIds: readonly string[],
  executor: DbExecutor = db
): Promise<Map<string, InstrumentWatcherInfo>> {
  const result = new Map<string, InstrumentWatcherInfo>();
  if (instrumentIds.length === 0) {
    return result;
  }

  const [activeRows, pastRows] = await Promise.all([
    executor
      .select({
        id: watchers.id,
        instrumentId: watchers.instrumentId,
        hostname: watchers.hostname,
        hostKey: sql<string | null>`lower(${watchers.hostname})`,
        osInfo: watchers.osInfo,
        watcherVersion: watchers.watcherVersion,
        status: watchers.status,
        statusReason: watchers.statusReason,
        lastHeartbeatAt: watchers.lastHeartbeatAt,
        configYaml: watchers.configYaml,
        configRevisionStatus: currentRevisionStatusSql,
        pcEditAwaitingRestart: pcEditAwaitingRestartSql,
      })
      .from(watchers)
      .where(
        and(
          isNull(watchers.deletedAt),
          inArray(watchers.instrumentId, [...instrumentIds])
        )
      ),
    executor
      .select({
        instrumentId: watchers.instrumentId,
        count: sql<number>`cast(count(*) as int)`,
        latestId: sql<string>`(array_agg(${watchers.id} order by ${watchers.deletedAt} desc))[1]`,
        latestHostname: sql<
          string | null
        >`(array_agg(${watchers.hostname} order by ${watchers.deletedAt} desc))[1]`,
      })
      .from(watchers)
      .where(
        and(
          isNotNull(watchers.deletedAt),
          inArray(watchers.instrumentId, [...instrumentIds])
        )
      )
      .groupBy(watchers.instrumentId),
  ]);

  // Other instruments whose active watcher reports the same hostname. This
  // looks at every active watcher on those computers, not only those of the
  // instruments asked for.
  const hostKeys = [
    ...new Set(
      activeRows
        .map((row) => row.hostKey)
        .filter((key): key is string => key !== null)
    ),
  ];
  const sameComputerRows =
    hostKeys.length === 0
      ? []
      : await executor
          .select({
            instrumentId: watchers.instrumentId,
            displayName: instruments.displayName,
            hostKey: sql<string>`lower(${watchers.hostname})`,
          })
          .from(watchers)
          .innerJoin(instruments, eq(instruments.id, watchers.instrumentId))
          .where(
            and(
              isNull(watchers.deletedAt),
              inArray(sql`lower(${watchers.hostname})`, hostKeys)
            )
          );

  const pastByInstrument = new Map(
    pastRows.map((row) => [row.instrumentId, row])
  );
  const activeByInstrument = new Map(
    activeRows.map((row) => [row.instrumentId, row])
  );
  const now = new Date();

  for (const instrumentId of instrumentIds) {
    const past = pastByInstrument.get(instrumentId);
    const pastWatcherCount = past?.count ?? 0;
    const mostRecentPastWatcher: PastWatcherRef | null = past
      ? { id: past.latestId, hostname: past.latestHostname }
      : null;

    const row = activeByInstrument.get(instrumentId);
    let watcher: InstrumentWatcher | null = null;
    if (row) {
      const fields = readInstrumentConfigFields(row.configYaml);
      watcher = {
        id: row.id,
        hostname: row.hostname,
        osInfo: row.osInfo,
        version: row.watcherVersion,
        status: computeEffectiveStatus({ ...row, deletedAt: null }, now),
        statusReason: row.statusReason,
        lastHeartbeatAt: row.lastHeartbeatAt,
        watchDirectory: fields.watchDirectory,
        filePatterns: fields.filePatterns,
        uploadMode: fields.uploadMode,
        configState: deriveConfigState(
          row.configRevisionStatus,
          row.pcEditAwaitingRestart
        ),
        sharedComputerWith: sameComputerRows
          .filter(
            (other) =>
              other.hostKey === row.hostKey &&
              other.instrumentId !== instrumentId
          )
          .map((other) => ({
            instrumentId: other.instrumentId,
            displayName: other.displayName,
          }))
          .sort(
            (a, b) =>
              a.displayName.localeCompare(b.displayName) ||
              a.instrumentId.localeCompare(b.instrumentId)
          ),
      };
    }

    result.set(instrumentId, {
      watcher,
      pastWatcherCount,
      mostRecentPastWatcher,
      connection: computeConnection(watcher, pastWatcherCount),
    });
  }

  return result;
}

/** The active watcher of one instrument, as much of it as the connection needs. */
async function readConnectionWatcher(
  instrumentId: string,
  executor: DbExecutor
): Promise<ConnectionWatcher | null> {
  const [row] = await executor
    .select({
      status: watchers.status,
      statusReason: watchers.statusReason,
      lastHeartbeatAt: watchers.lastHeartbeatAt,
    })
    .from(watchers)
    .where(
      and(eq(watchers.instrumentId, instrumentId), isNull(watchers.deletedAt))
    )
    .limit(1);
  if (!row) {
    return null;
  }
  return {
    status: computeEffectiveStatus({ ...row, deletedAt: null }),
    statusReason: row.statusReason,
  };
}

/**
 * Only the connection state of one instrument, in one query. For the checks
 * that decide whether work can reach the watcher, such as queueing uploads,
 * which read it on every request and don't need the reason. It reads `offline`
 * for an instrument with no active watcher, as `getInstrumentConnection` does.
 */
export async function getInstrumentConnectionState(
  instrumentId: string,
  executor: DbExecutor = db
): Promise<Connection["state"]> {
  const watcher = await readConnectionWatcher(instrumentId, executor);
  return computeConnection(watcher, 0).state;
}

/**
 * The connection of one instrument, without the rest of its watcher. It costs a
 * second query when the instrument has no active watcher, to tell a deregistered
 * watcher from none ever; use `getInstrumentConnectionState` when only the
 * state matters.
 */
export async function getInstrumentConnection(
  instrumentId: string,
  executor: DbExecutor = db
): Promise<Connection> {
  const watcher = await readConnectionWatcher(instrumentId, executor);
  if (watcher) {
    return computeConnection(watcher, 0);
  }

  const [past] = await executor
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(watchers)
    .where(
      and(
        eq(watchers.instrumentId, instrumentId),
        isNotNull(watchers.deletedAt)
      )
    );
  return computeConnection(null, past?.count ?? 0);
}

/**
 * Whether the caller may see where a watcher runs. Host details (hostname, OS,
 * version, watch folder and the other instruments on the same computer) were
 * `watchers:read` data before instruments carried a `watcher`, so
 * `instruments:read` alone doesn't unlock them. Browser sessions hold every
 * scope. Use this for every REST response that embeds a watcher.
 */
export function canReadWatcherHostDetails(auth: { scopes: string[] }): boolean {
  return hasScope(auth, "watchers:read");
}

/**
 * An instrument's `watcher` as REST returns it: snake_case, dates as ISO 8601.
 * For a caller without `watchers:read`, `hostname`, `os_info`, `version`,
 * `watch_directory` and `shared_computer_with` are left out (the keys are
 * absent, not null, since null already means "unknown" for most of them).
 * Status, heartbeat, patterns, upload mode and settings state stay.
 */
export function instrumentWatcherToRest(
  watcher: InstrumentWatcher | null,
  auth: { scopes: string[] }
) {
  if (watcher === null) {
    return null;
  }
  const shared = {
    id: watcher.id,
    status: watcher.status,
    status_reason: watcher.statusReason,
    last_heartbeat_at: watcher.lastHeartbeatAt?.toISOString() ?? null,
    file_patterns: watcher.filePatterns,
    upload_mode: watcher.uploadMode,
    config_state: watcher.configState,
  };
  if (!canReadWatcherHostDetails(auth)) {
    return shared;
  }
  return {
    ...shared,
    hostname: watcher.hostname,
    os_info: watcher.osInfo,
    version: watcher.version,
    watch_directory: watcher.watchDirectory,
    shared_computer_with: watcher.sharedComputerWith.map((other) => ({
      instrument_id: other.instrumentId,
      display_name: other.displayName,
    })),
  };
}
