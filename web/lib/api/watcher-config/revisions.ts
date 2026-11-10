// Server-stored watcher config revisions. An admin's change becomes a
// `pending` revision; the watcher sees the new number in its heartbeat reply,
// fetches the revision, and reports `applied` or `rejected`. Edits made on
// the instrument PC arrive through `PUT /watchers/:id/config` and are
// recorded as `pc` revisions, so every change lands in one history.

import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  type Actor,
  type ActorRef,
  actorColumns,
  resolveActor,
} from "@/lib/api/actor";
import { CONFLICT, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { WATCHER_FEATURES } from "@/lib/api/watcher-compat";
import { isAtLeast } from "@/lib/api/watcher-versions";
import { type DbExecutor, db } from "@/lib/db";
import {
  files,
  instrumentRuns,
  personalAccessTokens,
  users,
  watcherConfigRevisions,
  watcherEvents,
  watchers,
} from "@/lib/db/schema";
import { parseSettingsFromYaml } from "./from-yaml";
import { type PreviewFile, previewSettings } from "./preview";
import {
  canonicalSettings,
  settingsEqual,
  settingsFromStored,
  type WatcherConfigSettings,
} from "./settings";

export type ConfigRevisionSource =
  (typeof watcherConfigRevisions.$inferSelect)["source"];
export type ConfigRevisionStatus =
  (typeof watcherConfigRevisions.$inferSelect)["status"];

export interface ConfigRevision {
  createdAt: Date;
  /** For display (`<ActorLabel>`). */
  createdBy: Actor | null;
  /** The raw user row behind `createdBy`, for the wire `created_by` field. */
  createdByUser: { id: string; name: string; email: string } | null;
  resolvedAt: Date | null;
  revision: number;
  settings: WatcherConfigSettings;
  source: ConfigRevisionSource;
  status: ConfigRevisionStatus;
  statusReason: string | null;
}

/** The snake_case Revision object from the wire contract. */
export interface ConfigRevisionWire {
  created_at: string;
  created_by: { id: string; name: string; email: string } | null;
  created_by_token: { id: string; name: string } | null;
  resolved_at: string | null;
  revision: number;
  settings: WatcherConfigSettings;
  source: ConfigRevisionSource;
  status: ConfigRevisionStatus;
  status_reason: string | null;
}

export function toRevisionWire(rev: ConfigRevision): ConfigRevisionWire {
  const actor = rev.createdBy;
  return {
    revision: rev.revision,
    source: rev.source,
    status: rev.status,
    status_reason: rev.statusReason,
    settings: rev.settings,
    created_at: rev.createdAt.toISOString(),
    resolved_at: rev.resolvedAt ? rev.resolvedAt.toISOString() : null,
    created_by: rev.createdByUser,
    created_by_token:
      actor?.kind === "token"
        ? { id: actor.token.id, name: actor.token.name }
        : null,
  };
}

// The version that understands config revisions. Edits for older watchers
// are refused because they'd never be picked up.
export const REMOTE_CONFIG_MIN_VERSION = WATCHER_FEATURES.remoteConfig;

export function watcherSupportsRemoteConfig(
  watcherVersion: string | null
): boolean {
  return isAtLeast(watcherVersion, REMOTE_CONFIG_MIN_VERSION);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export const CONFIG_REVISIONS_DEFAULT_LIMIT = 50;
export const CONFIG_REVISIONS_MAX_LIMIT = 200;

async function selectRevisions(
  watcherId: string,
  opts: {
    revision?: number;
    limit: number;
    statuses?: readonly ConfigRevisionStatus[];
    excludeSuperseded?: boolean;
  },
  executor: DbExecutor = db
): Promise<ConfigRevision[]> {
  const conditions = [eq(watcherConfigRevisions.watcherId, watcherId)];
  if (opts.revision !== undefined) {
    conditions.push(eq(watcherConfigRevisions.revision, opts.revision));
  }
  if (opts.statuses !== undefined) {
    conditions.push(inArray(watcherConfigRevisions.status, [...opts.statuses]));
  }
  if (opts.excludeSuperseded) {
    conditions.push(ne(watcherConfigRevisions.status, "superseded"));
  }
  const rows = await executor
    .select({
      revision: watcherConfigRevisions.revision,
      source: watcherConfigRevisions.source,
      status: watcherConfigRevisions.status,
      statusReason: watcherConfigRevisions.statusReason,
      settings: watcherConfigRevisions.settings,
      createdAt: watcherConfigRevisions.createdAt,
      resolvedAt: watcherConfigRevisions.resolvedAt,
      userId: watcherConfigRevisions.createdBy,
      userName: users.name,
      userEmail: users.email,
      userImage: users.image,
      tokenId: watcherConfigRevisions.createdByToken,
      tokenName: personalAccessTokens.name,
      tokenRevokedAt: personalAccessTokens.revokedAt,
    })
    .from(watcherConfigRevisions)
    .leftJoin(users, eq(users.id, watcherConfigRevisions.createdBy))
    .leftJoin(
      personalAccessTokens,
      eq(personalAccessTokens.id, watcherConfigRevisions.createdByToken)
    )
    .where(and(...conditions))
    .orderBy(desc(watcherConfigRevisions.revision))
    .limit(opts.limit);

  return rows.map((row) => ({
    revision: row.revision,
    source: row.source,
    status: row.status,
    statusReason: row.statusReason,
    settings: settingsFromStored(row.settings),
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    createdBy: resolveActor(row),
    createdByUser: row.userId
      ? {
          id: row.userId,
          name: row.userName ?? row.userEmail ?? "",
          email: row.userEmail ?? "",
        }
      : null,
  }));
}

/** Newest first. */
export async function listConfigRevisions(
  watcherId: string,
  limit = CONFIG_REVISIONS_DEFAULT_LIMIT
): Promise<ConfigRevision[]> {
  return await selectRevisions(watcherId, { limit });
}

/** The highest-numbered revision, whatever its status. */
export async function getLatestConfigRevision(
  watcherId: string,
  executor: DbExecutor = db
): Promise<ConfigRevision | null> {
  const [latest] = await selectRevisions(watcherId, { limit: 1 }, executor);
  return latest ?? null;
}

/** The newest pending revision, if any. At most one is pending at a time. */
export async function getPendingConfigRevision(
  watcherId: string,
  executor: DbExecutor = db
): Promise<ConfigRevision | null> {
  const [pending] = await selectRevisions(
    watcherId,
    { limit: 1, statuses: ["pending"] },
    executor
  );
  return pending ?? null;
}

// A rejected revision was never run (the watcher kept its settings), and a
// superseded one was replaced by a newer change, so neither describes what
// the watcher runs or is about to run.
const INTENDED_STATUSES = ["pending", "applied"] as const;

/**
 * The revision whose settings the watcher runs or is about to run: the
 * newest `pending` or `applied` one. Saves and pushes are compared with it,
 * so a rejected change can be saved again once its cause is fixed, and a
 * partial MCP update doesn't carry a rejected change along.
 */
export async function getIntendedConfigRevision(
  watcherId: string,
  executor: DbExecutor = db
): Promise<ConfigRevision | null> {
  const [intended] = await selectRevisions(
    watcherId,
    { limit: 1, statuses: INTENDED_STATUSES },
    executor
  );
  return intended ?? null;
}

/** Same rule as `getIntendedConfigRevision`, over a newest-first list. */
export function pickIntendedRevision(
  revisions: readonly ConfigRevision[]
): ConfigRevision | null {
  return (
    revisions.find((rev) =>
      (INTENDED_STATUSES as readonly string[]).includes(rev.status)
    ) ?? null
  );
}

async function getNewestAppliedRevision(
  watcherId: string,
  executor: DbExecutor
): Promise<ConfigRevision | null> {
  const [applied] = await selectRevisions(
    watcherId,
    { limit: 1, statuses: ["applied"] },
    executor
  );
  return applied ?? null;
}

/**
 * What `GET /watchers/:id/config-revisions/latest` returns: the newest
 * pending revision, else the highest one. When the web wins an offline
 * conflict, the PC edit is stored as a higher `superseded` revision above the
 * pending web change, and the watcher must still get the web change.
 */
export async function getRevisionForWatcher(
  watcherId: string
): Promise<ConfigRevision | null> {
  return (
    (await getPendingConfigRevision(watcherId)) ??
    (await getLatestConfigRevision(watcherId))
  );
}

/**
 * The revision that describes the watcher's intended settings: the newest
 * one that wasn't superseded (a pending change, or the last applied or
 * rejected one). Superseded revisions are history only. Falls back to the
 * highest revision.
 */
export async function getCurrentConfigRevision(
  watcherId: string,
  executor: DbExecutor = db
): Promise<ConfigRevision | null> {
  const [current] = await selectRevisions(
    watcherId,
    { limit: 1, excludeSuperseded: true },
    executor
  );
  return current ?? (await getLatestConfigRevision(watcherId, executor));
}

/** Same rule as `getCurrentConfigRevision`, over a newest-first list. */
export function pickCurrentRevision(
  revisions: readonly ConfigRevision[]
): ConfigRevision | null {
  return (
    revisions.find((rev) => rev.status !== "superseded") ?? revisions[0] ?? null
  );
}

export async function getConfigRevision(
  watcherId: string,
  revision: number,
  executor: DbExecutor = db
): Promise<ConfigRevision | null> {
  const [row] = await selectRevisions(
    watcherId,
    { revision, limit: 1 },
    executor
  );
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

interface Failure {
  code: string;
  details?: Record<string, unknown>;
  message: string;
  ok: false;
  status: number;
}

export type CreateRevisionResult =
  | { ok: true; revision: ConfigRevision }
  | Failure;

// Locks the watcher row so concurrent writers number revisions one at a
// time. Every revision write goes through here inside a transaction.
async function lockWatcher(tx: DbExecutor, watcherId: string) {
  const [row] = await tx
    .select({
      id: watchers.id,
      watcherVersion: watchers.watcherVersion,
      configYaml: watchers.configYaml,
      appliedConfigRevision: watchers.appliedConfigRevision,
    })
    .from(watchers)
    .where(and(eq(watchers.id, watcherId), isNull(watchers.deletedAt)))
    .limit(1)
    .for("update");
  return row ?? null;
}

async function insertRevision(
  tx: DbExecutor,
  values: {
    watcherId: string;
    revision: number;
    source: ConfigRevisionSource;
    status: ConfigRevisionStatus;
    statusReason?: string | null;
    settings: WatcherConfigSettings;
    actor: ActorRef | null;
  }
) {
  const { userId, tokenId } = actorColumns(values.actor);
  const resolved = values.status !== "pending";
  await tx.insert(watcherConfigRevisions).values({
    watcherId: values.watcherId,
    revision: values.revision,
    source: values.source,
    status: values.status,
    statusReason: values.statusReason ?? null,
    settings: canonicalSettings(values.settings),
    createdBy: userId,
    createdByToken: tokenId,
    resolvedAt: resolved ? new Date() : null,
  });
}

async function resolveRevision(
  tx: DbExecutor,
  watcherId: string,
  revision: number,
  status: Exclude<ConfigRevisionStatus, "pending">,
  reason: string | null
) {
  await tx
    .update(watcherConfigRevisions)
    .set({ status, statusReason: reason, resolvedAt: new Date() })
    .where(
      and(
        eq(watcherConfigRevisions.watcherId, watcherId),
        eq(watcherConfigRevisions.revision, revision)
      )
    );
}

/**
 * Stores an admin's change as a new pending `web` revision.
 * `baseRevision` must be the latest revision number (or null when there is
 * none), so two admins editing at once can't overwrite each other unseen.
 */
export async function createWebConfigRevision(opts: {
  watcherId: string;
  baseRevision: number | null;
  settings: WatcherConfigSettings;
  actor: ActorRef;
}): Promise<CreateRevisionResult> {
  return await db.transaction(async (tx) => {
    const watcher = await lockWatcher(tx, opts.watcherId);
    if (!watcher) {
      return {
        ok: false,
        status: 404,
        code: NOT_FOUND,
        message: `Watcher '${opts.watcherId}' not found`,
      } satisfies Failure;
    }

    if (!watcherSupportsRemoteConfig(watcher.watcherVersion)) {
      return {
        ok: false,
        status: 409,
        code: CONFLICT,
        message: `Update the watcher to ${REMOTE_CONFIG_MIN_VERSION} to edit its config from Data Hub.`,
        details: {
          reason: "watcher_update_required",
          min_version: REMOTE_CONFIG_MIN_VERSION,
          watcher_version: watcher.watcherVersion,
        },
      } satisfies Failure;
    }

    const latest = await getLatestConfigRevision(opts.watcherId, tx);
    const latestNumber = latest?.revision ?? null;
    if (opts.baseRevision !== latestNumber) {
      return {
        ok: false,
        status: 409,
        code: CONFLICT,
        message:
          "The config was changed by someone else. Reload to see the latest version.",
        details: { reason: "stale_revision", latest_revision: latestNumber },
      } satisfies Failure;
    }

    // Compare against what the watcher runs or is about to run, skipping
    // superseded and rejected history, so a rejected change can be saved
    // again once its cause is fixed. With no such revision, the watcher's
    // own pushed YAML is the baseline.
    const intended = latest
      ? await getIntendedConfigRevision(opts.watcherId, tx)
      : null;
    const baseline = intended
      ? intended.settings
      : parseSettingsFromYaml(watcher.configYaml);
    if (baseline && settingsEqual(baseline, opts.settings)) {
      return {
        ok: false,
        status: 400,
        code: VALIDATION_ERROR,
        message: "No changes",
      } satisfies Failure;
    }

    const next = (latestNumber ?? 0) + 1;

    // Only the newest change should reach the watcher.
    await tx
      .update(watcherConfigRevisions)
      .set({
        status: "superseded",
        statusReason: `Replaced by revision ${next} before the watcher applied it`,
        resolvedAt: new Date(),
      })
      .where(
        and(
          eq(watcherConfigRevisions.watcherId, opts.watcherId),
          eq(watcherConfigRevisions.status, "pending")
        )
      );

    await insertRevision(tx, {
      watcherId: opts.watcherId,
      revision: next,
      source: "web",
      status: "pending",
      settings: opts.settings,
      actor: opts.actor,
    });
    await tx
      .update(watchers)
      .set({ configRevision: next })
      .where(eq(watchers.id, opts.watcherId));

    const created = await getConfigRevision(opts.watcherId, next, tx);
    // biome-ignore lint/style/noNonNullAssertion: inserted in this transaction
    return { ok: true, revision: created! };
  });
}

/**
 * Records the revision side of a watcher's config push
 * (`PUT /watchers/:id/config`). Returns the highest revision number after
 * the push, or null when there are none and the YAML couldn't be parsed.
 */
export async function recordWatcherConfigPush(opts: {
  watcherId: string;
  configYaml: string;
  basedOnRevision: number | null;
  modifiedAt: Date | null;
  tokenActor: ActorRef;
}): Promise<number | null> {
  return await db.transaction(async (tx) => {
    const watcher = await lockWatcher(tx, opts.watcherId);
    if (!watcher) {
      return null;
    }
    const latest = await getLatestConfigRevision(opts.watcherId, tx);
    const pushed = parseSettingsFromYaml(opts.configYaml);
    if (!pushed) {
      return latest?.revision ?? null;
    }

    const basedOn = opts.basedOnRevision ?? 0;
    // `latest` numbers the next revision. `intended` is what the watcher runs
    // or is about to run: a pending change, else the last applied one.
    // Superseded and rejected revisions are history only (the watcher never
    // ran them), so a push is never compared with them.
    const intended = latest
      ? await getIntendedConfigRevision(opts.watcherId, tx)
      : null;
    let next = (latest?.revision ?? 0) + 1;
    let applied: number | null = null;

    // A PC edit that the watcher runs replaces any change still waiting.
    const insertAppliedPcRevision = async () => {
      await tx
        .update(watcherConfigRevisions)
        .set({
          status: "superseded",
          statusReason: `Replaced by a newer edit on the instrument PC (revision ${next})`,
          resolvedAt: new Date(),
        })
        .where(
          and(
            eq(watcherConfigRevisions.watcherId, opts.watcherId),
            eq(watcherConfigRevisions.status, "pending")
          )
        );
      await insertRevision(tx, {
        watcherId: opts.watcherId,
        revision: next,
        source: "pc",
        status: "applied",
        settings: pushed,
        actor: opts.tokenActor,
      });
      applied = next;
    };

    if (!(latest && intended)) {
      await insertAppliedPcRevision();
    } else if (settingsEqual(pushed, intended.settings)) {
      // The watcher already runs this revision. If its result call was
      // lost, the push is the proof that it applied it.
      if (intended.status === "pending" && basedOn >= intended.revision) {
        await resolveRevision(
          tx,
          opts.watcherId,
          intended.revision,
          "applied",
          null
        );
        applied = intended.revision;
      }
      next = latest.revision;
    } else if (
      intended.status === "pending" &&
      intended.source === "web" &&
      intended.revision > basedOn
    ) {
      // The PC file changed while a web change waited. If the settings Data
      // Hub edits are still the ones the watcher last applied, only other
      // fields (such as `initial_scan`) or nothing at all changed, so there
      // is no conflict: the pending change stays and the watcher applies it
      // next. Otherwise it's an offline conflict, and the newer edit wins
      // while the other stays in history.
      const lastApplied = await getNewestAppliedRevision(opts.watcherId, tx);
      const pcIsNewer =
        opts.modifiedAt !== null &&
        opts.modifiedAt.getTime() > intended.createdAt.getTime();
      if (lastApplied && settingsEqual(pushed, lastApplied.settings)) {
        next = latest.revision;
      } else if (pcIsNewer) {
        await insertAppliedPcRevision();
      } else if (
        await hasRecordedPcEdit(tx, opts.watcherId, intended.revision, pushed)
      ) {
        // The same offline edit was pushed before (the watcher restarted
        // before applying the web change). It's already in the history.
        next = latest.revision;
      } else {
        // The web change is newer and stays pending. Keep the PC edit as
        // history. `GET …/config-revisions/latest` serves the pending
        // revision ahead of this higher superseded one.
        await insertRevision(tx, {
          watcherId: opts.watcherId,
          revision: next,
          source: "pc",
          status: "superseded",
          statusReason: `Edited on the instrument PC while offline. The newer change from Data Hub (revision ${intended.revision}) wins.`,
          settings: pushed,
          actor: opts.tokenActor,
        });
      }
    } else {
      // A pending revision the watcher has already moved past was applied
      // before this edit, even if its result call never arrived.
      if (intended.status === "pending") {
        await resolveRevision(
          tx,
          opts.watcherId,
          intended.revision,
          "applied",
          null
        );
      }
      await insertAppliedPcRevision();
    }

    await tx
      .update(watchers)
      .set({
        configRevision: next,
        ...(applied === null
          ? {}
          : {
              appliedConfigRevision: sql`greatest(coalesce(${watchers.appliedConfigRevision}, 0), ${applied})`,
            }),
      })
      .where(eq(watchers.id, opts.watcherId));

    return next;
  });
}

// A watcher can push the same offline edit more than once (for example when
// it restarts before applying the pending change). Record it only once:
// look for an equal superseded PC revision above the pending one.
async function hasRecordedPcEdit(
  tx: DbExecutor,
  watcherId: string,
  aboveRevision: number,
  settings: WatcherConfigSettings
): Promise<boolean> {
  const rows = await tx
    .select({ settings: watcherConfigRevisions.settings })
    .from(watcherConfigRevisions)
    .where(
      and(
        eq(watcherConfigRevisions.watcherId, watcherId),
        eq(watcherConfigRevisions.source, "pc"),
        eq(watcherConfigRevisions.status, "superseded"),
        sql`${watcherConfigRevisions.revision} > ${aboveRevision}`
      )
    );
  return rows.some((row) =>
    settingsEqual(settingsFromStored(row.settings), settings)
  );
}

export type RevisionResultOutcome =
  | { ok: true; revision: ConfigRevision }
  | Failure;

/**
 * Records the watcher's verdict on a revision. A status only moves from
 * `pending`; repeating the same status is a no-op.
 */
export async function recordConfigRevisionResult(opts: {
  watcherId: string;
  revision: number;
  status: "applied" | "rejected";
  reason: string | null;
}): Promise<RevisionResultOutcome> {
  return await db.transaction(async (tx) => {
    await lockWatcher(tx, opts.watcherId);
    const current = await getConfigRevision(opts.watcherId, opts.revision, tx);
    if (!current) {
      return {
        ok: false,
        status: 404,
        code: NOT_FOUND,
        message: `Config revision ${opts.revision} not found`,
      } satisfies Failure;
    }
    if (current.status === opts.status) {
      return { ok: true, revision: current };
    }
    if (current.status !== "pending") {
      return {
        ok: false,
        status: 409,
        code: CONFLICT,
        message: `Config revision ${opts.revision} is already ${current.status}`,
        details: { status: current.status },
      } satisfies Failure;
    }

    const reason = opts.reason?.trim() ? opts.reason.trim() : null;
    const now = new Date();
    await tx
      .update(watcherConfigRevisions)
      .set({
        status: opts.status,
        statusReason: opts.status === "rejected" ? reason : null,
        resolvedAt: now,
      })
      .where(
        and(
          eq(watcherConfigRevisions.watcherId, opts.watcherId),
          eq(watcherConfigRevisions.revision, opts.revision),
          eq(watcherConfigRevisions.status, "pending")
        )
      );

    if (opts.status === "applied") {
      await tx
        .update(watchers)
        .set({
          appliedConfigRevision: sql`greatest(coalesce(${watchers.appliedConfigRevision}, 0), ${opts.revision})`,
        })
        .where(eq(watchers.id, opts.watcherId));
      await tx.insert(watcherEvents).values({
        watcherId: opts.watcherId,
        eventType: "config_synced",
        message: `Applied config revision ${opts.revision}`,
        details: { kind: "config_revision_applied", revision: opts.revision },
        timestamp: now,
      });
    } else {
      await tx.insert(watcherEvents).values({
        watcherId: opts.watcherId,
        eventType: "error",
        message: reason
          ? `Rejected config revision ${opts.revision}: ${reason}`
          : `Rejected config revision ${opts.revision}`,
        details: {
          kind: "config_revision_rejected",
          revision: opts.revision,
          reason,
        },
        timestamp: now,
      });
    }

    const updated = await getConfigRevision(opts.watcherId, opts.revision, tx);
    // biome-ignore lint/style/noNonNullAssertion: read in this transaction
    return { ok: true, revision: updated! };
  });
}

// ---------------------------------------------------------------------------
// Preview and UI state
// ---------------------------------------------------------------------------

export const PREVIEW_SAMPLE_SIZE = 200;

/** Runs `settings` against the instrument's latest raw file paths. */
export async function previewConfigForInstrument(
  instrumentId: string,
  settings: WatcherConfigSettings
): Promise<{ sample_size: number; files: PreviewFile[] }> {
  const rows = await db
    .select({ relativePath: files.relativePath, filename: files.filename })
    .from(files)
    .innerJoin(instrumentRuns, eq(instrumentRuns.id, files.instrumentRunId))
    .where(
      and(
        eq(instrumentRuns.instrumentId, instrumentId),
        eq(files.category, "raw"),
        isNull(files.deletedAt)
      )
    )
    .orderBy(desc(files.createdAt), desc(files.id))
    // Reprocessed or re-uploaded files repeat a path, so read extra rows and
    // keep the newest of each.
    .limit(PREVIEW_SAMPLE_SIZE * 2);

  const paths = [
    ...new Set(rows.map((row) => row.relativePath ?? row.filename)),
  ].slice(0, PREVIEW_SAMPLE_SIZE);
  return {
    sample_size: paths.length,
    files: previewSettings(settings, paths),
  };
}

export interface WatcherConfigState {
  appliedConfigRevision: number | null;
  /** The settings the form starts from: `latest`, else the pushed YAML. */
  baseSettings: WatcherConfigSettings | null;
  /** The highest revision number, sent as `base_revision` on save. */
  configRevision: number | null;
  editable: boolean;
  /**
   * The current revision: a pending change, else the last applied or
   * rejected one. A rejected one keeps its settings in the form so the admin
   * can fix them and save again.
   */
  latest: ConfigRevision | null;
  /** What the watcher last reported in its pushed YAML. */
  reportedSettings: WatcherConfigSettings | null;
  /**
   * What a save is compared with (see `getIntendedConfigRevision`), else the
   * pushed YAML. The server refuses a save with these settings as "No
   * changes", so the form and Restore do too.
   */
  savedSettings: WatcherConfigSettings | null;
  watcherVersion: string | null;
}

/**
 * What the edit form needs, for the Configuration tab and the dialog.
 * `latest` is the current revision (see `getCurrentConfigRevision`), which
 * the callout describes and the form starts from. Pass `known` when the
 * caller already loaded the revisions.
 */
export async function getWatcherConfigState(
  watcher: {
    id: string;
    configYaml: string | null;
    watcherVersion: string | null;
    configRevision: number | null;
    appliedConfigRevision: number | null;
  },
  known?: { latest: ConfigRevision | null; intended: ConfigRevision | null }
): Promise<WatcherConfigState> {
  const [latest, intended] = known
    ? [known.latest, known.intended]
    : await Promise.all([
        getCurrentConfigRevision(watcher.id),
        getIntendedConfigRevision(watcher.id),
      ]);
  const reportedSettings = parseSettingsFromYaml(watcher.configYaml);
  return {
    watcherVersion: watcher.watcherVersion,
    editable: watcherSupportsRemoteConfig(watcher.watcherVersion),
    configRevision: watcher.configRevision,
    appliedConfigRevision: watcher.appliedConfigRevision,
    latest,
    reportedSettings,
    baseSettings: latest?.settings ?? reportedSettings,
    savedSettings: intended?.settings ?? reportedSettings,
  };
}
