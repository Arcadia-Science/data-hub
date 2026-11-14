// Every watcher, active and deregistered, for Settings › Watchers. One query
// reads the watchers with their instruments and with who deregistered each.
// The computers that active watchers share come from the same rows, so the list
// makes no query per row. `getWatcherList` keeps its shape for the MCP tools.

import { desc, eq } from "drizzle-orm";
import { actorDisplayName, resolveActor } from "@/lib/api/actor";
import {
  currentRevisionStatusSql,
  pcEditAwaitingRestartSql,
} from "@/lib/api/watcher-config/revisions";
import { computeEffectiveStatus } from "@/lib/api/watcher-status";
import type { WatcherListItem } from "@/lib/api/watchers";
import { db } from "@/lib/db";
import {
  instruments,
  personalAccessTokens,
  users,
  watchers,
} from "@/lib/db/schema";
import {
  deriveConfigState,
  type InstrumentWatcherConfigState,
  type SharedComputerInstrument,
} from "@/lib/instruments/connection";
import { sharedComputerWithByWatcher } from "@/lib/watchers/roster";

/** A watcher row on Settings › Watchers. */
export interface WatcherRosterItem extends WatcherListItem {
  /** The settings state, for the list's Settings column. */
  configState: InstrumentWatcherConfigState;
  /**
   * Who deregistered the watcher, by user or token name. Null while the
   * watcher is active, and when the deregistration wasn't recorded.
   */
  deregisteredByName: string | null;
  /**
   * The other active watchers on this computer, compared without case. Empty
   * when it runs no other, and for a deregistered watcher.
   */
  sharedComputerWith: SharedComputerInstrument[];
}

/** Every watcher, newest first. Callers split the active and deregistered ones. */
export async function getWatcherRoster(): Promise<WatcherRosterItem[]> {
  const rows = await db
    .select({
      id: watchers.id,
      instrumentId: watchers.instrumentId,
      instrumentDisplayName: instruments.displayName,
      hostname: watchers.hostname,
      watcherVersion: watchers.watcherVersion,
      status: watchers.status,
      statusReason: watchers.statusReason,
      configRevision: watchers.configRevision,
      appliedConfigRevision: watchers.appliedConfigRevision,
      configRevisionStatus: currentRevisionStatusSql,
      pcEditAwaitingRestart: pcEditAwaitingRestartSql,
      lastHeartbeatAt: watchers.lastHeartbeatAt,
      createdAt: watchers.createdAt,
      deletedAt: watchers.deletedAt,
      deregisteredByUserId: watchers.deregisteredBy,
      deregisteredByTokenId: watchers.deregisteredByToken,
      deregisteredByName: users.name,
      deregisteredByEmail: users.email,
      deregisteredByImage: users.image,
      deregisteredByTokenName: personalAccessTokens.name,
      deregisteredByTokenRevokedAt: personalAccessTokens.revokedAt,
    })
    .from(watchers)
    .leftJoin(instruments, eq(instruments.id, watchers.instrumentId))
    // The person or token that deregistered the watcher. All NULL for an
    // active watcher, and for one deregistered before the column existed.
    .leftJoin(users, eq(users.id, watchers.deregisteredBy))
    .leftJoin(
      personalAccessTokens,
      eq(personalAccessTokens.id, watchers.deregisteredByToken)
    )
    .orderBy(desc(watchers.createdAt));

  const sharedWith = sharedComputerWithByWatcher(
    rows.map((row) => ({
      id: row.id,
      instrumentId: row.instrumentId,
      displayName: row.instrumentDisplayName ?? row.instrumentId,
      hostname: row.hostname,
      active: row.deletedAt === null,
    }))
  );

  return rows.map((row) => {
    const deregisteredBy = resolveActor({
      userId: row.deregisteredByUserId,
      userName: row.deregisteredByName,
      userEmail: row.deregisteredByEmail,
      userImage: row.deregisteredByImage,
      tokenId: row.deregisteredByTokenId,
      tokenName: row.deregisteredByTokenName,
      tokenRevokedAt: row.deregisteredByTokenRevokedAt,
    });
    return {
      id: row.id,
      instrumentId: row.instrumentId,
      instrumentDisplayName: row.instrumentDisplayName,
      hostname: row.hostname,
      watcherVersion: row.watcherVersion,
      effectiveStatus: computeEffectiveStatus(row),
      statusReason: row.statusReason,
      configRevision: row.configRevision,
      appliedConfigRevision: row.appliedConfigRevision,
      configRevisionStatus: row.configRevisionStatus,
      pcEditAwaitingRestart: row.pcEditAwaitingRestart,
      lastHeartbeatAt: row.lastHeartbeatAt,
      createdAt: row.createdAt,
      deletedAt: row.deletedAt,
      configState: deriveConfigState(
        row.configRevisionStatus,
        row.pcEditAwaitingRestart
      ),
      deregisteredByName: deregisteredBy
        ? actorDisplayName(deregisteredBy)
        : null,
      sharedComputerWith: sharedWith.get(row.id) ?? [],
    };
  });
}
