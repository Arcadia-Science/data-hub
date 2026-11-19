import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  type Actor,
  type ActorRef,
  actorColumns,
  resolveActor,
} from "@/lib/api/actor";
import { escapeLikePattern } from "@/lib/api/like-pattern";
import { touchRuns } from "@/lib/api/touch-runs";
import { toUserAvatarUser, type UserAvatarUser } from "@/lib/avatar-color";
import { type DbExecutor, db } from "@/lib/db";
import {
  instrumentRuns,
  notebooks,
  personalAccessTokens,
  runAttributions,
  runNotebookLinks,
  users,
} from "@/lib/db/schema";
import {
  NOTEBOOK_LINK_URL_MESSAGE,
  NOTEBOOK_RUNS_PER_REQUEST_MAX,
  NOTEBOOKS_PER_RUN_MAX,
  notebookSearchKey,
  parseNotebookLinkUrl,
} from "@/lib/notebook-links/url";

// ---------------------------------------------------------------------------
// Lab notebooks and the runs in them. REST, MCP, and the web pages all go
// through these functions, so the rules live in one place:
// - A notebook is one page. Only one notebook, deleted or not, can hold a
//   page (`url_key`), so linking a page always finds the same notebook.
// - Any signed-in person, or a token with `notebooks:write`, can create,
//   edit, delete, or restore a notebook and add or remove its runs.
// - Deleting a notebook sets `deleted_at` and keeps its run links, so
//   restoring it brings them back. A deleted notebook can't change until it
//   is restored, and runs don't list it.
// - A run can be in at most NOTEBOOKS_PER_RUN_MAX notebooks, deleted ones
//   included, so restoring one never pushes a run past the limit. A deleted
//   run's notebooks can't change.
// - Adding or removing runs locks those runs in id order, so concurrent
//   writes take turns and the limit check can't race. It also bumps each
//   changed run's `updated_at`, which the runs tables show as "Last Updated".
//   Editing, deleting, or restoring a notebook doesn't, because it would
//   touch every run in the notebook at once.
// ---------------------------------------------------------------------------

export interface NotebookDto {
  createdAt: Date;
  // A person or token. Null once the person is deleted.
  createdBy: Actor | null;
  deletedAt: Date | null;
  deletedBy: Actor | null;
  description: string | null;
  id: string;
  // How many instruments the notebook's live runs come from.
  instrumentCount: number;
  // When the notebook's newest live run started, by acquired or created time.
  lastRunAt: Date | null;
  name: string;
  owner: UserAvatarUser | null;
  // How many live (not deleted) runs are in the notebook.
  runCount: number;
  updatedAt: Date;
  updatedBy: Actor | null;
  url: string;
  urlKey: string;
}

/** A notebook as one run lists it. */
export interface RunNotebookDto {
  id: string;
  linkedAt: Date;
  // Who added the run to the notebook.
  linkedBy: Actor | null;
  name: string;
  // The run's internal UUID.
  runId: string;
  url: string;
  urlKey: string;
}

export interface NotebookError {
  code: "VALIDATION_ERROR" | "NOT_FOUND" | "CONFLICT";
  details?: Record<string, unknown>;
  message: string;
  ok: false;
  status: 400 | 404 | 409;
}

export type NotebookResult<T> = { ok: true; value: T } | NotebookError;

function failure(
  status: NotebookError["status"],
  message: string,
  details?: Record<string, unknown>
): NotebookError {
  const code =
    status === 400
      ? "VALIDATION_ERROR"
      : status === 404
        ? "NOT_FOUND"
        : "CONFLICT";
  return { ok: false, status, code, message, ...(details && { details }) };
}

const NOTEBOOK_NOT_FOUND = "Notebook not found";
const NOTEBOOK_DELETED = "This notebook is deleted. Restore it first.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `id` can be a notebook ID. Anything else matches no notebook. */
export function isNotebookId(id: string): boolean {
  return UUID.test(id);
}

// ---------------------------------------------------------------------------
// Reading notebooks
// ---------------------------------------------------------------------------

const ownerUser = alias(users, "owner_user");
const creatorUser = alias(users, "creator_user");
const creatorToken = alias(personalAccessTokens, "creator_token");
const updaterUser = alias(users, "updater_user");
const updaterToken = alias(personalAccessTokens, "updater_token");
const deleterUser = alias(users, "deleter_user");
const deleterToken = alias(personalAccessTokens, "deleter_token");

const runStartedAt = sql`coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt})`;

// Run count, instrument count, and newest run per notebook, over live runs.
function notebookStats() {
  return db
    .select({
      notebookId: runNotebookLinks.notebookId,
      runCount: sql<number>`cast(count(*) as int)`.as("run_count"),
      instrumentCount:
        sql<number>`cast(count(distinct ${instrumentRuns.instrumentId}) as int)`.as(
          "instrument_count"
        ),
      lastRunAt: sql<Date | string | null>`max(${runStartedAt})`.as(
        "last_run_at"
      ),
    })
    .from(runNotebookLinks)
    .innerJoin(
      instrumentRuns,
      and(
        eq(instrumentRuns.id, runNotebookLinks.runId),
        isNull(instrumentRuns.deletedAt)
      )
    )
    .groupBy(runNotebookLinks.notebookId)
    .as("notebook_stats");
}

function selectNotebooks(executor: DbExecutor = db) {
  const stats = notebookStats();
  const query = executor
    .select({
      id: notebooks.id,
      url: notebooks.url,
      urlKey: notebooks.urlKey,
      name: notebooks.name,
      description: notebooks.description,
      runCount: stats.runCount,
      instrumentCount: stats.instrumentCount,
      lastRunAt: stats.lastRunAt,
      createdAt: notebooks.createdAt,
      updatedAt: notebooks.updatedAt,
      deletedAt: notebooks.deletedAt,
      ownerId: ownerUser.id,
      ownerName: ownerUser.name,
      ownerEmail: ownerUser.email,
      ownerImage: ownerUser.image,
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
      deleterUserId: deleterUser.id,
      deleterUserName: deleterUser.name,
      deleterUserEmail: deleterUser.email,
      deleterUserImage: deleterUser.image,
      deleterTokenId: deleterToken.id,
      deleterTokenName: deleterToken.name,
      deleterTokenRevokedAt: deleterToken.revokedAt,
    })
    .from(notebooks)
    .leftJoin(stats, eq(stats.notebookId, notebooks.id))
    .leftJoin(ownerUser, eq(ownerUser.id, notebooks.ownerId))
    .leftJoin(creatorUser, eq(creatorUser.id, notebooks.createdBy))
    .leftJoin(creatorToken, eq(creatorToken.id, notebooks.createdByToken))
    .leftJoin(updaterUser, eq(updaterUser.id, notebooks.updatedBy))
    .leftJoin(updaterToken, eq(updaterToken.id, notebooks.updatedByToken))
    .leftJoin(deleterUser, eq(deleterUser.id, notebooks.deletedBy))
    .leftJoin(deleterToken, eq(deleterToken.id, notebooks.deletedByToken));
  return { query, stats };
}

type NotebookRow = Awaited<ReturnType<typeof selectNotebooks>["query"]>[number];

function toDate(value: Date | string | null): Date | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value : new Date(value);
}

function toNotebookDto(row: NotebookRow): NotebookDto {
  return {
    id: row.id,
    url: row.url,
    urlKey: row.urlKey,
    name: row.name,
    description: row.description,
    owner: row.ownerId
      ? toUserAvatarUser({
          userId: row.ownerId,
          name: row.ownerName,
          email: row.ownerEmail,
          image: row.ownerImage,
        })
      : null,
    runCount: row.runCount ?? 0,
    instrumentCount: row.instrumentCount ?? 0,
    lastRunAt: toDate(row.lastRunAt),
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
    deletedAt: row.deletedAt,
    deletedBy: resolveActor({
      userId: row.deleterUserId,
      userName: row.deleterUserName,
      userEmail: row.deleterUserEmail,
      userImage: row.deleterUserImage,
      tokenId: row.deleterTokenId,
      tokenName: row.deleterTokenName,
      tokenRevokedAt: row.deleterTokenRevokedAt,
    }),
  };
}

/** One notebook, deleted or not. Null when there is none with that ID. */
export async function getNotebook(id: string): Promise<NotebookDto | null> {
  if (!isNotebookId(id)) {
    return null;
  }
  const [row] = await selectNotebooks().query.where(eq(notebooks.id, id));
  return row ? toNotebookDto(row) : null;
}

async function getNotebookOrThrow(id: string): Promise<NotebookDto> {
  const notebook = await getNotebook(id);
  if (!notebook) {
    // The caller wrote the row in a transaction that just committed.
    throw new Error(`Notebook ${id} vanished after it was written`);
  }
  return notebook;
}

export const NOTEBOOK_SORTS = [
  "last_run",
  "name",
  "run_count",
  "created",
] as const;
export type NotebookSort = (typeof NOTEBOOK_SORTS)[number];

export interface ListNotebooksInput {
  includeDeleted?: boolean;
  order?: "asc" | "desc";
  ownerId?: string;
  page?: number;
  perPage?: number;
  // A name, part of a description, or a pasted link. A link matches only
  // the notebook for that page.
  query?: string;
  sort?: NotebookSort;
}

export interface NotebookList {
  notebooks: NotebookDto[];
  page: number;
  perPage: number;
  total: number;
}

export const NOTEBOOKS_PER_PAGE_DEFAULT = 50;
export const NOTEBOOKS_PER_PAGE_MAX = 200;

function notebookListConditions(input: ListNotebooksInput): SQL | undefined {
  const conditions: SQL[] = [];
  if (!input.includeDeleted) {
    conditions.push(isNull(notebooks.deletedAt));
  }
  if (input.ownerId) {
    conditions.push(eq(notebooks.ownerId, input.ownerId));
  }
  const query = input.query?.trim();
  if (query) {
    const pattern = `%${escapeLikePattern(query)}%`;
    const text = or(
      ilike(notebooks.name, pattern),
      ilike(notebooks.description, pattern),
      ilike(notebooks.url, pattern)
    ) as SQL;
    const urlKey = notebookSearchKey(query);
    if (!urlKey) {
      conditions.push(text);
    } else if (query.includes("://")) {
      // A pasted link matches only the notebook for that page.
      conditions.push(eq(notebooks.urlKey, urlKey));
    } else {
      // Text like "v2.1" or "notion.so/abc" could be a name or a link
      // without its scheme, so it matches either way.
      conditions.push(or(eq(notebooks.urlKey, urlKey), text) as SQL);
    }
  }
  return conditions.length > 0 ? and(...conditions) : undefined;
}

/** Notebooks matching the filters, a page at a time. */
export async function listNotebooks(
  input: ListNotebooksInput = {}
): Promise<NotebookList> {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const perPage = Math.min(
    NOTEBOOKS_PER_PAGE_MAX,
    Math.max(1, Math.floor(input.perPage ?? NOTEBOOKS_PER_PAGE_DEFAULT))
  );
  const where = notebookListConditions(input);
  const { query, stats } = selectNotebooks();
  const direction = input.order ?? (input.sort === "name" ? "asc" : "desc");
  const sortColumn = {
    last_run: sql`${stats.lastRunAt}`,
    name: sql`lower(${notebooks.name})`,
    run_count: sql`coalesce(${stats.runCount}, 0)`,
    created: sql`${notebooks.createdAt}`,
  }[input.sort ?? "last_run"];
  const primary =
    direction === "asc"
      ? sql`${sortColumn} asc nulls last`
      : sql`${sortColumn} desc nulls last`;

  const [rows, [{ value: total }]] = await Promise.all([
    query
      .where(where)
      .orderBy(primary, asc(sql`lower(${notebooks.name})`), asc(notebooks.id))
      .limit(perPage)
      .offset((page - 1) * perPage),
    db.select({ value: count() }).from(notebooks).where(where),
  ]);
  return { notebooks: rows.map(toNotebookDto), total, page, perPage };
}

// ---------------------------------------------------------------------------
// A run's notebooks
// ---------------------------------------------------------------------------

const linkerUser = alias(users, "linker_user");
const linkerToken = alias(personalAccessTokens, "linker_token");

function selectRunNotebooks() {
  return db
    .select({
      runId: runNotebookLinks.runId,
      id: notebooks.id,
      name: notebooks.name,
      url: notebooks.url,
      urlKey: notebooks.urlKey,
      linkedAt: runNotebookLinks.createdAt,
      linkerUserId: linkerUser.id,
      linkerUserName: linkerUser.name,
      linkerUserEmail: linkerUser.email,
      linkerUserImage: linkerUser.image,
      linkerTokenId: linkerToken.id,
      linkerTokenName: linkerToken.name,
      linkerTokenRevokedAt: linkerToken.revokedAt,
    })
    .from(runNotebookLinks)
    .innerJoin(
      notebooks,
      and(
        eq(notebooks.id, runNotebookLinks.notebookId),
        isNull(notebooks.deletedAt)
      )
    )
    .leftJoin(linkerUser, eq(linkerUser.id, runNotebookLinks.createdBy))
    .leftJoin(linkerToken, eq(linkerToken.id, runNotebookLinks.createdByToken));
}

type RunNotebookRow = Awaited<ReturnType<typeof selectRunNotebooks>>[number];

function toRunNotebookDto(row: RunNotebookRow): RunNotebookDto {
  return {
    id: row.id,
    runId: row.runId,
    name: row.name,
    url: row.url,
    urlKey: row.urlKey,
    linkedAt: row.linkedAt,
    linkedBy: resolveActor({
      userId: row.linkerUserId,
      userName: row.linkerUserName,
      userEmail: row.linkerUserEmail,
      userImage: row.linkerUserImage,
      tokenId: row.linkerTokenId,
      tokenName: row.linkerTokenName,
      tokenRevokedAt: row.linkerTokenRevokedAt,
    }),
  };
}

// Oldest first, so a run's first notebook stays put as more are added.
const runNotebookOrder = [
  asc(runNotebookLinks.createdAt),
  asc(runNotebookLinks.id),
];

/** The notebooks a run is in, oldest link first. Deleted ones are left out. */
export async function listNotebooksForRun(
  runInternalId: string
): Promise<RunNotebookDto[]> {
  const rows = await selectRunNotebooks()
    .where(eq(runNotebookLinks.runId, runInternalId))
    .orderBy(...runNotebookOrder);
  return rows.map(toRunNotebookDto);
}

/** The notebooks for many runs at once, keyed by internal run UUID. */
export async function getNotebooksByRunIds(
  runInternalIds: readonly string[]
): Promise<Map<string, RunNotebookDto[]>> {
  const byRun = new Map<string, RunNotebookDto[]>();
  const unique = [...new Set(runInternalIds)];
  if (unique.length === 0) {
    return byRun;
  }
  const rows = await selectRunNotebooks()
    .where(inArray(runNotebookLinks.runId, unique))
    .orderBy(...runNotebookOrder);
  for (const row of rows) {
    const list = byRun.get(row.runId) ?? [];
    list.push(toRunNotebookDto(row));
    byRun.set(row.runId, list);
  }
  return byRun;
}

/** SQL for the runs list's "in any notebook" filter. Deleted notebooks don't count. */
export function hasNotebookCondition(hasNotebook: boolean): SQL {
  const linked = sql`exists (select 1 from ${runNotebookLinks} join ${notebooks} on ${notebooks.id} = ${runNotebookLinks.notebookId} where ${runNotebookLinks.runId} = ${instrumentRuns.id} and ${notebooks.deletedAt} is null)`;
  return hasNotebook ? linked : sql`not ${linked}`;
}

/**
 * SQL for the runs list's notebook filter: runs in this notebook. A deleted
 * notebook still lists its runs, so its page can show what restoring brings
 * back.
 */
export function inNotebookCondition(notebookId: string): SQL {
  if (!isNotebookId(notebookId)) {
    return sql`false`;
  }
  return sql`exists (select 1 from ${runNotebookLinks} where ${runNotebookLinks.runId} = ${instrumentRuns.id} and ${runNotebookLinks.notebookId} = ${notebookId})`;
}

/** A notebook in the "Lab Notebook" column's filter menu. */
export interface NotebookFilterOption {
  id: string;
  name: string;
  // Live runs in the table's scope that are in the notebook.
  runCount: number;
}

/**
 * The notebooks the "Lab Notebook" column's filter menu lists, most runs
 * first. Pass an instrument for its runs table, or a person for the runs
 * attributed to them. Deleted runs and notebooks don't count.
 */
export async function getNotebookFilterOptions(
  scope: { instrumentId?: string; ranBy?: string } = {}
): Promise<NotebookFilterOption[]> {
  const runCount = sql<number>`cast(count(distinct ${instrumentRuns.id}) as int)`;
  return await db
    .select({ id: notebooks.id, name: notebooks.name, runCount })
    .from(runNotebookLinks)
    .innerJoin(
      notebooks,
      and(
        eq(notebooks.id, runNotebookLinks.notebookId),
        isNull(notebooks.deletedAt)
      )
    )
    .innerJoin(instrumentRuns, eq(instrumentRuns.id, runNotebookLinks.runId))
    .where(
      and(
        isNull(instrumentRuns.deletedAt),
        scope.instrumentId
          ? eq(instrumentRuns.instrumentId, scope.instrumentId)
          : undefined,
        scope.ranBy
          ? sql`exists (select 1 from ${runAttributions} where ${runAttributions.runId} = ${instrumentRuns.id} and ${runAttributions.userId} = ${scope.ranBy})`
          : undefined
      )
    )
    .groupBy(notebooks.id, notebooks.name)
    .orderBy(desc(runCount), asc(sql`lower(${notebooks.name})`));
}

// ---------------------------------------------------------------------------
// Writing notebooks
// ---------------------------------------------------------------------------

function authorColumns(
  actor: ActorRef,
  prefix: "created" | "updated" | "deleted"
) {
  const { userId, tokenId } = actorColumns(actor);
  switch (prefix) {
    case "created":
      return { createdBy: userId, createdByToken: tokenId };
    case "updated":
      return { updatedBy: userId, updatedByToken: tokenId };
    default:
      return { deletedBy: userId, deletedByToken: tokenId };
  }
}

// Two writers saving the same page take turns, so the "already has this
// page" check can't race the unique index.
async function lockPage(tx: DbExecutor, urlKey: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`notebook:${urlKey}`}, 0))`
  );
}

async function findNotebookByKey(
  tx: DbExecutor,
  urlKey: string,
  exceptId?: string
) {
  const [row] = await tx
    .select({
      id: notebooks.id,
      name: notebooks.name,
      deletedAt: notebooks.deletedAt,
    })
    .from(notebooks)
    .where(
      and(
        eq(notebooks.urlKey, urlKey),
        exceptId ? ne(notebooks.id, exceptId) : undefined
      )
    );
  return row ?? null;
}

function pageTaken(existing: {
  id: string;
  name: string;
  deletedAt: Date | null;
}): NotebookError {
  const message = existing.deletedAt
    ? `The deleted notebook "${existing.name}" already has this page. Restore it instead.`
    : `The notebook "${existing.name}" already has this page.`;
  return failure(409, message, {
    notebook_id: existing.id,
    deleted: existing.deletedAt !== null,
  });
}

async function ownerMissing(
  tx: DbExecutor,
  ownerId: string | null | undefined
): Promise<NotebookError | null> {
  if (!ownerId) {
    return null;
  }
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, ownerId));
  return row ? null : failure(400, `No user has the ID '${ownerId}'`);
}

// Locks the notebook row. Returns an error when it is missing or deleted.
async function lockLiveNotebook(
  tx: DbExecutor,
  id: string
): Promise<NotebookError | { deletedAt: Date | null; urlKey: string }> {
  if (!isNotebookId(id)) {
    return failure(404, NOTEBOOK_NOT_FOUND);
  }
  const [row] = await tx
    .select({ deletedAt: notebooks.deletedAt, urlKey: notebooks.urlKey })
    .from(notebooks)
    .where(eq(notebooks.id, id))
    .for("update");
  if (!row) {
    return failure(404, NOTEBOOK_NOT_FOUND);
  }
  if (row.deletedAt) {
    return failure(409, NOTEBOOK_DELETED);
  }
  return row;
}

function isError(value: unknown): value is NotebookError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false
  );
}

export interface CreateNotebookResult {
  notebook: NotebookDto;
  // Outcomes for the runs passed in, when any were.
  runs: RunOutcomes<AddRunOutcome> | null;
}

/**
 * Creates a notebook for a page, and adds runs to it in the same
 * transaction when any are given. 409 when a notebook, deleted or not,
 * already has the page: `details.notebook_id` names it and `details.deleted`
 * says whether it is deleted.
 */
export async function createNotebook(input: {
  url: string;
  name: string;
  description?: string | null;
  ownerId?: string | null;
  runs?: readonly RunKey[];
  actor: ActorRef;
}): Promise<NotebookResult<CreateNotebookResult>> {
  const parsed = parseNotebookLinkUrl(input.url);
  if (!parsed) {
    return failure(400, NOTEBOOK_LINK_URL_MESSAGE);
  }
  const runs = input.runs ? dedupeRuns(input.runs) : [];
  if (runs.length > NOTEBOOK_RUNS_PER_REQUEST_MAX) {
    return tooManyRuns();
  }

  const outcome = await db.transaction(
    async (
      tx
    ): Promise<
      NotebookResult<{
        id: string;
        runs: RunOutcomes<AddRunOutcome> | null;
      }>
    > => {
      await lockPage(tx, parsed.urlKey);
      const existing = await findNotebookByKey(tx, parsed.urlKey);
      if (existing) {
        return pageTaken(existing);
      }
      const missingOwner = await ownerMissing(tx, input.ownerId);
      if (missingOwner) {
        return missingOwner;
      }
      const [inserted] = await tx
        .insert(notebooks)
        .values({
          url: parsed.url,
          urlKey: parsed.urlKey,
          name: input.name,
          description: input.description ?? null,
          ownerId: input.ownerId ?? null,
          ...authorColumns(input.actor, "created"),
          ...authorColumns(input.actor, "updated"),
        })
        .returning({ id: notebooks.id });
      const added =
        runs.length > 0
          ? await addRunsInTransaction(tx, inserted.id, runs, input.actor)
          : null;
      return { ok: true, value: { id: inserted.id, runs: added } };
    }
  );
  if (!outcome.ok) {
    return outcome;
  }
  return {
    ok: true,
    value: {
      notebook: await getNotebookOrThrow(outcome.value.id),
      runs: outcome.value.runs,
    },
  };
}

/**
 * Edits a notebook. Omitted fields stay as they are; a null description or
 * owner clears it. A new link must point to a page no other notebook has.
 */
export async function updateNotebook(input: {
  id: string;
  name?: string;
  description?: string | null;
  ownerId?: string | null;
  url?: string;
  actor: ActorRef;
}): Promise<NotebookResult<NotebookDto>> {
  const parsed =
    input.url === undefined ? undefined : parseNotebookLinkUrl(input.url);
  if (parsed === null) {
    return failure(400, NOTEBOOK_LINK_URL_MESSAGE);
  }
  const outcome = await db.transaction(
    async (tx): Promise<NotebookResult<null>> => {
      const locked = await lockLiveNotebook(tx, input.id);
      if (isError(locked)) {
        return locked;
      }
      if (parsed && parsed.urlKey !== locked.urlKey) {
        await lockPage(tx, parsed.urlKey);
        const clash = await findNotebookByKey(tx, parsed.urlKey, input.id);
        if (clash) {
          return pageTaken(clash);
        }
      }
      const missingOwner = await ownerMissing(tx, input.ownerId);
      if (missingOwner) {
        return missingOwner;
      }
      const changes = {
        ...(parsed && { url: parsed.url, urlKey: parsed.urlKey }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && {
          description: input.description,
        }),
        ...(input.ownerId !== undefined && { ownerId: input.ownerId }),
      };
      if (Object.keys(changes).length > 0) {
        await tx
          .update(notebooks)
          .set({ ...changes, ...authorColumns(input.actor, "updated") })
          .where(eq(notebooks.id, input.id));
      }
      return { ok: true, value: null };
    }
  );
  if (!outcome.ok) {
    return outcome;
  }
  return { ok: true, value: await getNotebookOrThrow(input.id) };
}

/** Marks a notebook deleted. Its run links stay, for a restore. */
export async function deleteNotebook(input: {
  id: string;
  actor: ActorRef;
}): Promise<NotebookResult<NotebookDto>> {
  const outcome = await db.transaction(
    async (tx): Promise<NotebookResult<null>> => {
      const locked = await lockLiveNotebook(tx, input.id);
      if (isError(locked)) {
        return locked.status === 409
          ? failure(409, "This notebook is already deleted")
          : locked;
      }
      await tx
        .update(notebooks)
        .set({
          deletedAt: new Date(),
          ...authorColumns(input.actor, "deleted"),
        })
        .where(eq(notebooks.id, input.id));
      return { ok: true, value: null };
    }
  );
  if (!outcome.ok) {
    return outcome;
  }
  return { ok: true, value: await getNotebookOrThrow(input.id) };
}

/** Brings back a deleted notebook with the runs it had. */
export async function restoreNotebook(input: {
  id: string;
  actor: ActorRef;
}): Promise<NotebookResult<NotebookDto>> {
  if (!isNotebookId(input.id)) {
    return failure(404, NOTEBOOK_NOT_FOUND);
  }
  const outcome = await db.transaction(
    async (tx): Promise<NotebookResult<null>> => {
      const [row] = await tx
        .select({ deletedAt: notebooks.deletedAt })
        .from(notebooks)
        .where(eq(notebooks.id, input.id))
        .for("update");
      if (!row) {
        return failure(404, NOTEBOOK_NOT_FOUND);
      }
      if (!row.deletedAt) {
        return failure(409, "This notebook isn't deleted");
      }
      await tx
        .update(notebooks)
        .set({
          deletedAt: null,
          deletedBy: null,
          deletedByToken: null,
          ...authorColumns(input.actor, "updated"),
        })
        .where(eq(notebooks.id, input.id));
      return { ok: true, value: null };
    }
  );
  if (!outcome.ok) {
    return outcome;
  }
  return { ok: true, value: await getNotebookOrThrow(input.id) };
}

// ---------------------------------------------------------------------------
// Adding and removing runs
// ---------------------------------------------------------------------------

export interface RunKey {
  instrumentId: string;
  runId: string;
}

export type AddRunOutcome =
  | "added"
  | "already_in_notebook"
  | "run_deleted"
  | "limit_reached"
  | "not_found";

export type RemoveRunOutcome =
  | "removed"
  | "not_in_notebook"
  | "run_deleted"
  | "not_found";

export const ADD_RUN_OUTCOMES: readonly AddRunOutcome[] = [
  "added",
  "already_in_notebook",
  "run_deleted",
  "limit_reached",
  "not_found",
];

export const REMOVE_RUN_OUTCOMES: readonly RemoveRunOutcome[] = [
  "removed",
  "not_in_notebook",
  "run_deleted",
  "not_found",
];

/** One outcome per run, in the order the runs were given. */
export interface RunOutcomes<Outcome extends string> {
  notebookId: string;
  results: Array<RunKey & { outcome: Outcome }>;
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

function tooManyRuns(): NotebookError {
  return failure(
    400,
    `Change at most ${NOTEBOOK_RUNS_PER_REQUEST_MAX} runs at a time`
  );
}

function validateRunCount(runs: readonly RunKey[]): NotebookError | null {
  if (runs.length === 0) {
    return failure(400, "Choose at least one run");
  }
  return runs.length > NOTEBOOK_RUNS_PER_REQUEST_MAX ? tooManyRuns() : null;
}

// Locks the named runs in id order, so two writes over overlapping runs
// can't deadlock. Runs that don't exist are left out.
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

async function addRunsInTransaction(
  tx: DbExecutor,
  notebookId: string,
  runs: readonly RunKey[],
  actor: ActorRef
): Promise<RunOutcomes<AddRunOutcome>> {
  const locked = await lockRuns(tx, runs);
  const activeIds = [...locked.values()]
    .filter((run) => run.deletedAt === null)
    .map((run) => run.id);

  const alreadyIn = new Set<string>();
  const counts = new Map<string, number>();
  if (activeIds.length > 0) {
    const linked = await tx
      .select({ runId: runNotebookLinks.runId })
      .from(runNotebookLinks)
      .where(
        and(
          inArray(runNotebookLinks.runId, activeIds),
          eq(runNotebookLinks.notebookId, notebookId)
        )
      );
    for (const row of linked) {
      alreadyIn.add(row.runId);
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

  const decided = runs.map((run) => {
    const row = locked.get(runKeyString(run));
    let outcome: AddRunOutcome = "added";
    if (!row) {
      outcome = "not_found";
    } else if (row.deletedAt) {
      outcome = "run_deleted";
    } else if (alreadyIn.has(row.id)) {
      outcome = "already_in_notebook";
    } else if ((counts.get(row.id) ?? 0) >= NOTEBOOKS_PER_RUN_MAX) {
      outcome = "limit_reached";
    }
    return { run, outcome, internalId: row?.id ?? null };
  });

  const toAdd = decided
    .filter((entry) => entry.outcome === "added")
    .map((entry) => entry.internalId as string);
  if (toAdd.length > 0) {
    await tx.insert(runNotebookLinks).values(
      toAdd.map((runId) => ({
        runId,
        notebookId,
        ...authorColumns(actor, "created"),
      }))
    );
    await touchRuns(toAdd, tx);
  }
  return {
    notebookId,
    results: decided.map(({ run, outcome }) => ({ ...run, outcome })),
  };
}

/**
 * Adds runs to a notebook. Runs already in it stay as they are. Reports an
 * outcome for each run instead of failing the whole request.
 */
export async function addRunsToNotebook(input: {
  notebookId: string;
  runs: readonly RunKey[];
  actor: ActorRef;
}): Promise<NotebookResult<RunOutcomes<AddRunOutcome>>> {
  const runs = dedupeRuns(input.runs);
  const invalid = validateRunCount(runs);
  if (invalid) {
    return invalid;
  }
  return await db.transaction(async (tx) => {
    const locked = await lockLiveNotebook(tx, input.notebookId);
    if (isError(locked)) {
      return locked;
    }
    return {
      ok: true as const,
      value: await addRunsInTransaction(
        tx,
        input.notebookId,
        runs,
        input.actor
      ),
    };
  });
}

/**
 * Removes runs from a notebook. Reports an outcome for each run instead of
 * failing the whole request.
 */
export async function removeRunsFromNotebook(input: {
  notebookId: string;
  runs: readonly RunKey[];
}): Promise<NotebookResult<RunOutcomes<RemoveRunOutcome>>> {
  const runs = dedupeRuns(input.runs);
  const invalid = validateRunCount(runs);
  if (invalid) {
    return invalid;
  }
  return await db.transaction(async (tx) => {
    const lockedNotebook = await lockLiveNotebook(tx, input.notebookId);
    if (isError(lockedNotebook)) {
      return lockedNotebook;
    }
    const locked = await lockRuns(tx, runs);
    const activeIds = [...locked.values()]
      .filter((run) => run.deletedAt === null)
      .map((run) => run.id);
    const removed = new Set<string>();
    if (activeIds.length > 0) {
      const deleted = await tx
        .delete(runNotebookLinks)
        .where(
          and(
            inArray(runNotebookLinks.runId, activeIds),
            eq(runNotebookLinks.notebookId, input.notebookId)
          )
        )
        .returning({ runId: runNotebookLinks.runId });
      for (const row of deleted) {
        removed.add(row.runId);
      }
      await touchRuns([...removed], tx);
    }
    const results = runs.map((run) => {
      const row = locked.get(runKeyString(run));
      let outcome: RemoveRunOutcome = "not_in_notebook";
      if (!row) {
        outcome = "not_found";
      } else if (row.deletedAt) {
        outcome = "run_deleted";
      } else if (removed.has(row.id)) {
        outcome = "removed";
      }
      return { ...run, outcome };
    });
    return {
      ok: true as const,
      value: { notebookId: input.notebookId, results },
    };
  });
}
