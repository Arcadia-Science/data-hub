import { and, asc, count, eq, inArray, ne, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  type Actor,
  type ActorRef,
  actorColumns,
  resolveActor,
} from "@/lib/api/actor";
import { touchRuns } from "@/lib/api/touch-runs";
import { type DbExecutor, db } from "@/lib/db";
import {
  instrumentRuns,
  personalAccessTokens,
  runNotebookLinks,
  users,
} from "@/lib/db/schema";
import {
  NOTEBOOK_LINK_BULK_RUNS_MAX,
  NOTEBOOK_LINK_BULK_URLS_MAX,
  NOTEBOOK_LINK_URL_MESSAGE,
  NOTEBOOK_LINKS_PER_RUN_MAX,
  notebookLinkDisplayName,
  parseNotebookLinkUrl,
} from "@/lib/notebook-links/url";

// ---------------------------------------------------------------------------
// Lab notebook links on runs. REST, MCP, and the run page all go through
// these functions, so the rules live in one place:
// - Any signed-in person, or a token with `runs:link`, can add, edit, or
//   remove any link. A deleted run's links can't change.
// - A run can't hold two links to the same page (`url_key`), and holds at
//   most NOTEBOOK_LINKS_PER_RUN_MAX links.
// - Every write locks the run row first, so concurrent writes to one run
//   take turns and the duplicate and limit checks can't race.
// - A change bumps the run's `updated_at`, which the runs tables show as
//   "Last Updated".
// ---------------------------------------------------------------------------

export interface NotebookLinkDto {
  createdAt: Date;
  // A person or token. Null once the person who added it is deleted.
  createdBy: Actor | null;
  // The label, or a name worked out from the URL.
  displayName: string;
  id: string;
  label: string | null;
  // The run's internal UUID.
  runId: string;
  updatedAt: Date;
  updatedBy: Actor | null;
  url: string;
  urlKey: string;
}

export interface NotebookLinkError {
  code: "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT";
  details?: Record<string, unknown>;
  message: string;
  ok: false;
  status: 400 | 404 | 409;
}

export type NotebookLinkResult<T> = { ok: true; value: T } | NotebookLinkError;

function failure(
  status: NotebookLinkError["status"],
  message: string,
  details?: Record<string, unknown>
): NotebookLinkError {
  const code =
    status === 400
      ? "VALIDATION_ERROR"
      : status === 404
        ? "NOT_FOUND"
        : "CONFLICT";
  return { ok: false, status, code, message, ...(details && { details }) };
}

const creatorUser = alias(users, "creator_user");
const creatorToken = alias(personalAccessTokens, "creator_token");
const updaterUser = alias(users, "updater_user");
const updaterToken = alias(personalAccessTokens, "updater_token");

function selectLinks(executor: DbExecutor = db) {
  return executor
    .select({
      id: runNotebookLinks.id,
      runId: runNotebookLinks.runId,
      url: runNotebookLinks.url,
      urlKey: runNotebookLinks.urlKey,
      label: runNotebookLinks.label,
      createdAt: runNotebookLinks.createdAt,
      updatedAt: runNotebookLinks.updatedAt,
      creatorUserId: creatorUser.id,
      creatorUserName: creatorUser.name,
      creatorUserEmail: creatorUser.email,
      creatorUserImage: creatorUser.image,
      creatorTokenId: creatorToken.id,
      creatorTokenName: creatorToken.name,
      creatorTokenRevokedAt: creatorToken.revokedAt,
      updaterUserId: updaterUser.id,
      updaterUserName: updaterUser.name,
      updaterUserEmail: updaterUser.email,
      updaterUserImage: updaterUser.image,
      updaterTokenId: updaterToken.id,
      updaterTokenName: updaterToken.name,
      updaterTokenRevokedAt: updaterToken.revokedAt,
    })
    .from(runNotebookLinks)
    .leftJoin(creatorUser, eq(creatorUser.id, runNotebookLinks.createdBy))
    .leftJoin(
      creatorToken,
      eq(creatorToken.id, runNotebookLinks.createdByToken)
    )
    .leftJoin(updaterUser, eq(updaterUser.id, runNotebookLinks.updatedBy))
    .leftJoin(
      updaterToken,
      eq(updaterToken.id, runNotebookLinks.updatedByToken)
    );
}

type LinkRow = Awaited<ReturnType<typeof selectLinks>>[number];

function toDto(row: LinkRow): NotebookLinkDto {
  return {
    id: row.id,
    runId: row.runId,
    url: row.url,
    urlKey: row.urlKey,
    label: row.label,
    displayName: notebookLinkDisplayName(row.url, row.label),
    createdAt: row.createdAt,
    createdBy: resolveActor({
      userId: row.creatorUserId,
      userName: row.creatorUserName,
      userEmail: row.creatorUserEmail,
      userImage: row.creatorUserImage,
      tokenId: row.creatorTokenId,
      tokenName: row.creatorTokenName,
      tokenRevokedAt: row.creatorTokenRevokedAt,
    }),
    updatedAt: row.updatedAt,
    updatedBy: resolveActor({
      userId: row.updaterUserId,
      userName: row.updaterUserName,
      userEmail: row.updaterUserEmail,
      userImage: row.updaterUserImage,
      tokenId: row.updaterTokenId,
      tokenName: row.updaterTokenName,
      tokenRevokedAt: row.updaterTokenRevokedAt,
    }),
  };
}

// Oldest first, so a run's "first" link stays put as more are added.
const linkOrder = [asc(runNotebookLinks.createdAt), asc(runNotebookLinks.id)];

export async function listNotebookLinksForRun(
  runInternalId: string
): Promise<NotebookLinkDto[]> {
  const rows = await selectLinks()
    .where(eq(runNotebookLinks.runId, runInternalId))
    .orderBy(...linkOrder);
  return rows.map(toDto);
}

/** Links for many runs at once, keyed by internal run UUID. */
export async function getNotebookLinksByRunIds(
  runInternalIds: readonly string[]
): Promise<Map<string, NotebookLinkDto[]>> {
  const byRun = new Map<string, NotebookLinkDto[]>();
  const unique = [...new Set(runInternalIds)];
  if (unique.length === 0) {
    return byRun;
  }
  const rows = await selectLinks()
    .where(inArray(runNotebookLinks.runId, unique))
    .orderBy(...linkOrder);
  for (const row of rows) {
    const links = byRun.get(row.runId) ?? [];
    links.push(toDto(row));
    byRun.set(row.runId, links);
  }
  return byRun;
}

async function getLinksByIds(ids: readonly string[]) {
  if (ids.length === 0) {
    return new Map<string, NotebookLinkDto>();
  }
  const rows = await selectLinks().where(
    inArray(runNotebookLinks.id, [...ids])
  );
  return new Map(rows.map((row) => [row.id, toDto(row)]));
}

async function getLinkById(id: string): Promise<NotebookLinkDto> {
  const link = (await getLinksByIds([id])).get(id);
  if (!link) {
    // The caller wrote the row in a transaction that just committed.
    throw new Error(`Notebook link ${id} vanished after it was written`);
  }
  return link;
}

/** SQL for the runs list's "has a notebook link" filter. */
export function notebookLinkCondition(hasLink: boolean): SQL {
  const linked = sql`exists (select 1 from ${runNotebookLinks} where ${runNotebookLinks.runId} = ${instrumentRuns.id})`;
  return hasLink ? linked : sql`not ${linked}`;
}

// Locks the run so writes to its links take turns. Returns an error when
// the run is missing or deleted.
async function lockActiveRun(
  tx: DbExecutor,
  runInternalId: string
): Promise<NotebookLinkError | null> {
  const [run] = await tx
    .select({ deletedAt: instrumentRuns.deletedAt })
    .from(instrumentRuns)
    .where(eq(instrumentRuns.id, runInternalId))
    .for("update");
  if (!run) {
    return failure(404, "Run not found");
  }
  if (run.deletedAt) {
    return failure(409, "Cannot change notebook links on a deleted run");
  }
  return null;
}

function duplicateLink(linkId: string): NotebookLinkError {
  return failure(409, "This run already has a link to that page", {
    link_id: linkId,
  });
}

function limitReached(): NotebookLinkError {
  return failure(
    409,
    `A run can have at most ${NOTEBOOK_LINKS_PER_RUN_MAX} notebook links`
  );
}

async function findLinkByKey(
  tx: DbExecutor,
  runInternalId: string,
  urlKey: string,
  exceptId?: string
): Promise<string | null> {
  const [row] = await tx
    .select({ id: runNotebookLinks.id })
    .from(runNotebookLinks)
    .where(
      and(
        eq(runNotebookLinks.runId, runInternalId),
        eq(runNotebookLinks.urlKey, urlKey),
        exceptId ? ne(runNotebookLinks.id, exceptId) : undefined
      )
    );
  return row?.id ?? null;
}

function authorColumns(actor: ActorRef, prefix: "created" | "updated") {
  const { userId, tokenId } = actorColumns(actor);
  return prefix === "created"
    ? { createdBy: userId, createdByToken: tokenId }
    : { updatedBy: userId, updatedByToken: tokenId };
}

// ---------------------------------------------------------------------------
// One link at a time
// ---------------------------------------------------------------------------

export async function addNotebookLink(input: {
  runInternalId: string;
  url: string;
  label: string | null;
  actor: ActorRef;
}): Promise<NotebookLinkResult<NotebookLinkDto>> {
  const parsed = parseNotebookLinkUrl(input.url);
  if (!parsed) {
    return failure(400, NOTEBOOK_LINK_URL_MESSAGE);
  }
  const outcome = await db.transaction(
    async (tx): Promise<NotebookLinkResult<string>> => {
      const locked = await lockActiveRun(tx, input.runInternalId);
      if (locked) {
        return locked;
      }
      const existing = await findLinkByKey(
        tx,
        input.runInternalId,
        parsed.urlKey
      );
      if (existing) {
        return duplicateLink(existing);
      }
      const [{ value: linkCount }] = await tx
        .select({ value: count() })
        .from(runNotebookLinks)
        .where(eq(runNotebookLinks.runId, input.runInternalId));
      if (linkCount >= NOTEBOOK_LINKS_PER_RUN_MAX) {
        return limitReached();
      }
      const [inserted] = await tx
        .insert(runNotebookLinks)
        .values({
          runId: input.runInternalId,
          url: parsed.url,
          urlKey: parsed.urlKey,
          label: input.label,
          ...authorColumns(input.actor, "created"),
          ...authorColumns(input.actor, "updated"),
        })
        .returning({ id: runNotebookLinks.id });
      await touchRuns([input.runInternalId], tx);
      return { ok: true, value: inserted.id };
    }
  );
  if (!outcome.ok) {
    return outcome;
  }
  return { ok: true, value: await getLinkById(outcome.value) };
}

export async function updateNotebookLink(input: {
  runInternalId: string;
  linkId: string;
  // Omitted fields stay as they are. A null label clears it.
  url?: string;
  label?: string | null;
  actor: ActorRef;
}): Promise<NotebookLinkResult<NotebookLinkDto>> {
  const parsed =
    input.url === undefined ? undefined : parseNotebookLinkUrl(input.url);
  if (parsed === null) {
    return failure(400, NOTEBOOK_LINK_URL_MESSAGE);
  }
  const outcome = await db.transaction(
    async (tx): Promise<NotebookLinkResult<string>> => {
      const locked = await lockActiveRun(tx, input.runInternalId);
      if (locked) {
        return locked;
      }
      const [current] = await tx
        .select({
          url: runNotebookLinks.url,
          urlKey: runNotebookLinks.urlKey,
          label: runNotebookLinks.label,
        })
        .from(runNotebookLinks)
        .where(
          and(
            eq(runNotebookLinks.id, input.linkId),
            eq(runNotebookLinks.runId, input.runInternalId)
          )
        );
      if (!current) {
        return failure(404, "Notebook link not found");
      }
      const next = {
        url: parsed?.url ?? current.url,
        urlKey: parsed?.urlKey ?? current.urlKey,
        label: input.label === undefined ? current.label : input.label,
      };
      if (
        next.url === current.url &&
        next.urlKey === current.urlKey &&
        next.label === current.label
      ) {
        return { ok: true, value: input.linkId };
      }
      if (next.urlKey !== current.urlKey) {
        const clash = await findLinkByKey(
          tx,
          input.runInternalId,
          next.urlKey,
          input.linkId
        );
        if (clash) {
          return duplicateLink(clash);
        }
      }
      await tx
        .update(runNotebookLinks)
        .set({ ...next, ...authorColumns(input.actor, "updated") })
        .where(eq(runNotebookLinks.id, input.linkId));
      await touchRuns([input.runInternalId], tx);
      return { ok: true, value: input.linkId };
    }
  );
  if (!outcome.ok) {
    return outcome;
  }
  return { ok: true, value: await getLinkById(outcome.value) };
}

export async function removeNotebookLink(input: {
  runInternalId: string;
  linkId: string;
}): Promise<NotebookLinkResult<{ id: string }>> {
  return await db.transaction(async (tx) => {
    const locked = await lockActiveRun(tx, input.runInternalId);
    if (locked) {
      return locked;
    }
    const deleted = await tx
      .delete(runNotebookLinks)
      .where(
        and(
          eq(runNotebookLinks.id, input.linkId),
          eq(runNotebookLinks.runId, input.runInternalId)
        )
      )
      .returning({ id: runNotebookLinks.id });
    if (deleted.length === 0) {
      return failure(404, "Notebook link not found");
    }
    await touchRuns([input.runInternalId], tx);
    return { ok: true as const, value: { id: input.linkId } };
  });
}

// ---------------------------------------------------------------------------
// Many runs at once
// ---------------------------------------------------------------------------

export interface RunKey {
  instrumentId: string;
  runId: string;
}

export type BulkAddOutcome =
  | "added"
  | "already_linked"
  | "run_deleted"
  | "limit_reached"
  | "not_found";

export type BulkRemoveOutcome =
  | "removed"
  | "not_linked"
  | "run_deleted"
  | "not_found";

export interface BulkAddResult {
  results: Array<
    RunKey & { outcome: BulkAddOutcome; link: NotebookLinkDto | null }
  >;
  url: string;
  urlKey: string;
}

export interface BulkRemoveResult {
  results: Array<RunKey & { outcome: BulkRemoveOutcome; removed: number }>;
  urlKeys: string[];
}

function runKeyString(run: RunKey): string {
  return `${run.instrumentId}\u0000${run.runId}`;
}

// Run IDs are trimmed the same way `lookupRunByNaturalKey` trims them.
function dedupeRuns(runs: readonly RunKey[]): RunKey[] {
  const seen = new Map<string, RunKey>();
  for (const run of runs) {
    const key = { instrumentId: run.instrumentId, runId: run.runId.trim() };
    seen.set(runKeyString(key), key);
  }
  return [...seen.values()];
}

function validateRunCount(runs: readonly RunKey[]): NotebookLinkError | null {
  if (runs.length === 0) {
    return failure(400, "Choose at least one run");
  }
  if (runs.length > NOTEBOOK_LINK_BULK_RUNS_MAX) {
    return failure(
      400,
      `Change at most ${NOTEBOOK_LINK_BULK_RUNS_MAX} runs at a time`
    );
  }
  return null;
}

// Locks the named runs in id order, so two bulk writes over overlapping
// runs can't deadlock. Runs that don't exist are left out.
async function lockRuns(tx: DbExecutor, runs: readonly RunKey[]) {
  const pairs = sql.join(
    runs.map((run) => sql`(${run.instrumentId}, ${run.runId})`),
    sql`, `
  );
  const rows = await tx
    .select({
      id: instrumentRuns.id,
      instrumentId: instrumentRuns.instrumentId,
      runId: instrumentRuns.runId,
      deletedAt: instrumentRuns.deletedAt,
    })
    .from(instrumentRuns)
    .where(
      sql`(${instrumentRuns.instrumentId}, ${instrumentRuns.runId}) in (${pairs})`
    )
    .orderBy(asc(instrumentRuns.id))
    .for("update");
  return new Map(rows.map((row) => [runKeyString(row), row]));
}

/**
 * Adds one link to many runs. Runs that already link to the page keep their
 * link and its label. The result lists every run in the order given.
 */
export async function bulkAddNotebookLink(input: {
  runs: readonly RunKey[];
  url: string;
  label: string | null;
  actor: ActorRef;
}): Promise<NotebookLinkResult<BulkAddResult>> {
  const parsed = parseNotebookLinkUrl(input.url);
  if (!parsed) {
    return failure(400, NOTEBOOK_LINK_URL_MESSAGE);
  }
  const runs = dedupeRuns(input.runs);
  const invalid = validateRunCount(runs);
  if (invalid) {
    return invalid;
  }

  const decided = await db.transaction(async (tx) => {
    const locked = await lockRuns(tx, runs);
    const activeIds = [...locked.values()]
      .filter((run) => run.deletedAt === null)
      .map((run) => run.id);

    const existing = new Map<string, string>();
    const counts = new Map<string, number>();
    if (activeIds.length > 0) {
      const linked = await tx
        .select({ runId: runNotebookLinks.runId, id: runNotebookLinks.id })
        .from(runNotebookLinks)
        .where(
          and(
            inArray(runNotebookLinks.runId, activeIds),
            eq(runNotebookLinks.urlKey, parsed.urlKey)
          )
        );
      for (const row of linked) {
        existing.set(row.runId, row.id);
      }
      const counted = await tx
        .select({ runId: runNotebookLinks.runId, value: count() })
        .from(runNotebookLinks)
        .where(inArray(runNotebookLinks.runId, activeIds))
        .groupBy(runNotebookLinks.runId);
      for (const row of counted) {
        counts.set(row.runId, row.value);
      }
    }

    const outcomes = runs.map((run) => {
      const row = locked.get(runKeyString(run));
      if (!row) {
        return { run, outcome: "not_found" as const, internalId: null };
      }
      if (row.deletedAt) {
        return { run, outcome: "run_deleted" as const, internalId: row.id };
      }
      if (existing.has(row.id)) {
        return { run, outcome: "already_linked" as const, internalId: row.id };
      }
      if ((counts.get(row.id) ?? 0) >= NOTEBOOK_LINKS_PER_RUN_MAX) {
        return { run, outcome: "limit_reached" as const, internalId: row.id };
      }
      return { run, outcome: "added" as const, internalId: row.id };
    });

    const toAdd = outcomes
      .filter((entry) => entry.outcome === "added")
      .map((entry) => entry.internalId as string);
    const inserted =
      toAdd.length === 0
        ? []
        : await tx
            .insert(runNotebookLinks)
            .values(
              toAdd.map((runId) => ({
                runId,
                url: parsed.url,
                urlKey: parsed.urlKey,
                label: input.label,
                ...authorColumns(input.actor, "created"),
                ...authorColumns(input.actor, "updated"),
              }))
            )
            .returning({
              id: runNotebookLinks.id,
              runId: runNotebookLinks.runId,
            });
    for (const row of inserted) {
      existing.set(row.runId, row.id);
    }
    await touchRuns(toAdd, tx);
    return { outcomes, linkIdByRun: existing };
  });

  const links = await getLinksByIds([...decided.linkIdByRun.values()]);
  return {
    ok: true,
    value: {
      url: parsed.url,
      urlKey: parsed.urlKey,
      results: decided.outcomes.map(({ run, outcome, internalId }) => {
        const linkId =
          internalId && (outcome === "added" || outcome === "already_linked")
            ? decided.linkIdByRun.get(internalId)
            : undefined;
        return {
          instrumentId: run.instrumentId,
          runId: run.runId,
          outcome,
          link: linkId ? (links.get(linkId) ?? null) : null,
        };
      }),
    },
  };
}

/**
 * Removes the links to the given pages from many runs. A URL matches any
 * link to the same page, so a pasted variant of a saved link removes it.
 */
export async function bulkRemoveNotebookLinks(input: {
  runs: readonly RunKey[];
  urls: readonly string[];
}): Promise<NotebookLinkResult<BulkRemoveResult>> {
  if (input.urls.length === 0) {
    return failure(400, "Choose at least one link to remove");
  }
  if (input.urls.length > NOTEBOOK_LINK_BULK_URLS_MAX) {
    return failure(
      400,
      `Remove at most ${NOTEBOOK_LINK_BULK_URLS_MAX} links at a time`
    );
  }
  const urlKeys: string[] = [];
  for (const url of input.urls) {
    const parsed = parseNotebookLinkUrl(url);
    if (!parsed) {
      return failure(400, `${NOTEBOOK_LINK_URL_MESSAGE} Got: ${url}`);
    }
    if (!urlKeys.includes(parsed.urlKey)) {
      urlKeys.push(parsed.urlKey);
    }
  }
  const runs = dedupeRuns(input.runs);
  const invalid = validateRunCount(runs);
  if (invalid) {
    return invalid;
  }

  const results = await db.transaction(async (tx) => {
    const locked = await lockRuns(tx, runs);
    const activeIds = [...locked.values()]
      .filter((run) => run.deletedAt === null)
      .map((run) => run.id);
    const removedByRun = new Map<string, number>();
    if (activeIds.length > 0) {
      const deleted = await tx
        .delete(runNotebookLinks)
        .where(
          and(
            inArray(runNotebookLinks.runId, activeIds),
            inArray(runNotebookLinks.urlKey, urlKeys)
          )
        )
        .returning({ runId: runNotebookLinks.runId });
      for (const row of deleted) {
        removedByRun.set(row.runId, (removedByRun.get(row.runId) ?? 0) + 1);
      }
      await touchRuns([...removedByRun.keys()], tx);
    }
    return runs.map((run) => {
      const row = locked.get(runKeyString(run));
      const removed = row ? (removedByRun.get(row.id) ?? 0) : 0;
      let outcome: BulkRemoveOutcome = "not_linked";
      if (!row) {
        outcome = "not_found";
      } else if (row.deletedAt) {
        outcome = "run_deleted";
      } else if (removed > 0) {
        outcome = "removed";
      }
      return { ...run, outcome, removed };
    });
  });

  return { ok: true, value: { urlKeys, results } };
}
