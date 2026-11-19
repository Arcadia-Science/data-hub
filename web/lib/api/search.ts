import {
  and,
  asc,
  desc,
  eq,
  ilike,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { type ActorToken, actorUser, resolveActor } from "@/lib/api/actor";
import { getInstrumentListWithCounts } from "@/lib/api/instruments";
import { notebookQueryCondition, notebookStats } from "@/lib/api/notebooks";
import { db } from "@/lib/db";
import {
  files,
  instrumentRuns,
  instruments,
  notebooks,
  personalAccessTokens,
  runAttributions,
  runComments,
  users,
} from "@/lib/db/schema";
import {
  type Connection,
  type LegacyWatcherStatus,
  toLegacyWatcherStatus,
} from "@/lib/instruments/connection";
import { notebookSearchKey } from "@/lib/notebook-links/url";
import { commentBodyPreview } from "@/lib/search-comment-preview";
import { MIN_QUERY_LENGTH } from "@/lib/search-constants";

// Global search across top-level entities. Backed by the pg_trgm GIN indexes
// so the `ilike '%…%'` scans stay fast as the run/file/comment tables grow.
// Users (name/email) are intentionally searchable with the same `runs:read`
// gate as everything else — Data Hub has no row-level member privacy, and the
// Users scope mirrors the members directory / attributor picker.

export type SearchScope =
  | "all"
  | "runs"
  | "lab_notebooks"
  | "files"
  | "instruments"
  | "users"
  | "comments";

// Per-group cap when searching everything at once ("All" tab). Matches the
// mockups. A scoped search (single tab) uses SCOPED_LIMIT so "Show all"
// surfaces a longer list without a dedicated results page.
const ALL_TAB_PER_GROUP = 5;
const SCOPED_LIMIT = 25;

// Why a run surfaced. `run_id` is the run's own title (highest relevance);
// `file` means a contained filename matched (drives the "Contains …" line);
// `instrument`/`ran_by` are secondary metadata matches. Runs don't match
// through their lab notebooks: the notebook shows in the Notebooks group.
export type RunMatchReason = "run_id" | "file" | "instrument" | "ran_by";

export interface SearchRunResult {
  acquiredAt: string | null;
  createdAt: string;
  fileCount: number;
  id: string;
  instrumentId: string;
  instrumentName: string;
  // Set only when `matchReason` is "file" — an example matching filename.
  matchedFilename: string | null;
  matchReason: RunMatchReason;
  runId: string;
  totalSizeBytes: number;
  type: "run";
}

// A lab notebook, matched by its name or description, or by a pasted link
// to its page.
export interface SearchNotebookResult {
  id: string;
  name: string;
  // How many live (not deleted) runs are in the notebook, however many
  // results the search shows.
  runCount: number;
  type: "lab_notebook";
  // The notebook's own page, such as its Notion page.
  url: string;
}

export interface SearchFileResult {
  filename: string;
  id: number;
  instrumentId: string;
  instrumentName: string;
  runId: string;
  sizeBytes: number | null;
  type: "file";
}

export type InstrumentMatchReason = "name" | "pattern";

export interface SearchInstrumentResult {
  // How the instrument is connected to its watcher, the same value its
  // instrument responses carry. The badge reads it, with `status`.
  connection: Connection;
  displayName: string;
  id: string;
  /**
   * @deprecated Get the instrument for its `watcher.lastHeartbeatAt`.
   */
  lastWatcherHeartbeatAt: string | null;
  // Set only when `matchReason` is "pattern" — the configured pattern that
  // matched (e.g. "*.nd2"), so the client can highlight it.
  matchedPattern: string | null;
  matchReason: InstrumentMatchReason;
  runCount: number;
  status: "pending" | "active" | "inactive";
  type: "instrument";
  /**
   * `deregistered` (active instrument, only watcher deregistered) is distinct
   * from `no_watcher`. Only meaningful when `status` is `active`.
   * @deprecated Use `connection.state`, or `connection.reason`.
   */
  watcherStatus: LegacyWatcherStatus;
}

export interface SearchUserResult {
  email: string | null;
  id: string;
  image: string | null;
  name: string | null;
  type: "user";
}

// A person wrote the comment (`userId` and `userName` set) or a token did
// (`token` set, user fields null). The user fields keep their original names
// so existing API and MCP clients keep working.
export interface SearchCommentResult {
  bodyPreview: string;
  createdAt: string;
  id: string;
  instrumentId: string;
  instrumentName: string;
  runId: string;
  token: ActorToken | null;
  type: "comment";
  userId: string | null;
  userName: string | null;
}

export interface GlobalSearchResult {
  comments: SearchCommentResult[];
  counts: {
    comments: number;
    files: number;
    instruments: number;
    lab_notebooks: number;
    runs: number;
    // Sum of the *visible* (capped) results — this is the "N results for …"
    // figure the header shows, matching what the user actually sees.
    total: number;
    users: number;
  };
  files: SearchFileResult[];
  instruments: SearchInstrumentResult[];
  lab_notebooks: SearchNotebookResult[];
  runs: SearchRunResult[];
  users: SearchUserResult[];
}

// Escapes LIKE wildcards so user input matches literally. A filename like
// `.*jpg` or a pattern query must be treated as text, never as a LIKE/regex
// pattern. Mirrors the escaping already used in `buildRunListQuery`.
function escapeLike(query: string): string {
  return query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

const acquiredOrCreated = sql`coalesce(${instrumentRuns.acquiredAt}, ${instrumentRuns.createdAt})`;

async function searchRuns(
  query: string,
  limit: number
): Promise<SearchRunResult[]> {
  const escaped = escapeLike(query);
  const substring = `%${escaped}%`;
  const prefix = `${escaped}%`;

  // A run matches on its own id, its instrument's name, a contained (active)
  // filename, or an attributed user's name/email.
  const fileMatch = sql<boolean>`exists (select 1 from ${files} f where f.instrument_run_id = ${instrumentRuns.id} and f.deleted_at is null and f.filename ilike ${substring})`;
  const ranByMatch = sql<boolean>`exists (select 1 from ${runAttributions} ra join ${users} u on u.id = ra.user_id where ra.run_id = ${instrumentRuns.id} and (u.name ilike ${substring} or u.email ilike ${substring}))`;

  const matchCondition = or(
    ilike(instrumentRuns.runId, substring),
    ilike(instruments.displayName, substring),
    fileMatch,
    ranByMatch
  ) as SQL;

  const where = and(isNull(instrumentRuns.deletedAt), matchCondition);

  // Relevance: a prefix hit on the run id (the title), then any run-id
  // substring hit, then a metadata-only match; recency breaks ties.
  const relevance = sql<number>`case when ${instrumentRuns.runId} ilike ${prefix} then 2 when ${instrumentRuns.runId} ilike ${substring} then 1 else 0 end`;

  const rows = await db
    .select({
      id: instrumentRuns.id,
      runId: instrumentRuns.runId,
      instrumentId: instrumentRuns.instrumentId,
      instrumentName: instruments.displayName,
      acquiredAt: instrumentRuns.acquiredAt,
      createdAt: instrumentRuns.createdAt,
      // Raw-file aggregates mirror the run list rows shown elsewhere.
      fileCount: sql<number>`cast(count(${files.id}) filter (where ${files.deletedAt} is null) as int)`,
      totalSizeBytes: sql<number>`cast(coalesce(sum(${files.sizeBytes}) filter (where ${files.deletedAt} is null), 0) as bigint)`,
      matchedRunId: sql<boolean>`bool_or(${instrumentRuns.runId} ilike ${substring})`,
      matchedInstrument: sql<boolean>`bool_or(${instruments.displayName} ilike ${substring})`,
      matchedFile: sql<boolean>`bool_or(${fileMatch})`,
      matchedFilename: sql<
        string | null
      >`(select f.filename from ${files} f where f.instrument_run_id = ${instrumentRuns.id} and f.deleted_at is null and f.filename ilike ${substring} order by f.filename limit 1)`,
    })
    .from(instrumentRuns)
    .innerJoin(instruments, eq(instrumentRuns.instrumentId, instruments.id))
    .leftJoin(
      files,
      and(
        eq(files.instrumentRunId, instrumentRuns.id),
        eq(files.category, "raw")
      )
    )
    .where(where)
    .groupBy(instrumentRuns.id, instruments.displayName)
    .orderBy(desc(relevance), desc(acquiredOrCreated))
    .limit(limit);

  return rows.map((row) => {
    // Precedence: title match first, then a nested-file match (worth its
    // own "Contains …" line), then instrument, then attribution.
    let matchReason: RunMatchReason;
    if (row.matchedRunId) {
      matchReason = "run_id";
    } else if (row.matchedFile) {
      matchReason = "file";
    } else if (row.matchedInstrument) {
      matchReason = "instrument";
    } else {
      matchReason = "ran_by";
    }
    return {
      type: "run" as const,
      id: row.id,
      runId: row.runId,
      instrumentId: row.instrumentId,
      instrumentName: row.instrumentName,
      acquiredAt: row.acquiredAt ? row.acquiredAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      fileCount: row.fileCount,
      totalSizeBytes: Number(row.totalSizeBytes),
      matchReason,
      matchedFilename: matchReason === "file" ? row.matchedFilename : null,
    };
  });
}

// A notebook matches by name or description. A pasted link (with `://`)
// matches only the notebook for that page, compared by the same-page key
// (`notebookUrlKey`), so the scheme, `www.`, tracking parameters, the
// fragment, and a Notion page's title don't matter. Text like
// "notion.so/abc" matches either way. Deleted notebooks don't match.
async function searchNotebooks(
  query: string,
  limit: number
): Promise<SearchNotebookResult[]> {
  const escaped = escapeLike(query);
  const substring = `%${escaped}%`;
  const prefix = `${escaped}%`;
  // Part of a link counts too, so a bare Notion page ID finds its notebook,
  // the way the Notebooks list matches.
  const match = notebookQueryCondition(
    query,
    or(
      ilike(notebooks.name, substring),
      ilike(notebooks.description, substring),
      ilike(notebooks.url, substring)
    ) as SQL
  );

  // Relevance: the notebook for a pasted page, then a prefix hit on the
  // name. Ties go to the notebook with the newest run.
  const urlKey = notebookSearchKey(query);
  const pageMatch = urlKey ? sql`${notebooks.urlKey} = ${urlKey}` : sql`false`;
  const relevance = sql<number>`case when ${pageMatch} then 2 when ${notebooks.name} ilike ${prefix} then 1 else 0 end`;

  // The run count comes from every live run in the notebook, so it isn't
  // held to the result cap.
  const stats = notebookStats();
  const rows = await db
    .select({
      id: notebooks.id,
      name: notebooks.name,
      url: notebooks.url,
      runCount: stats.runCount,
    })
    .from(notebooks)
    .leftJoin(stats, eq(stats.notebookId, notebooks.id))
    .where(and(isNull(notebooks.deletedAt), match))
    .orderBy(
      desc(relevance),
      sql`${stats.lastRunAt} desc nulls last`,
      asc(sql`lower(${notebooks.name})`),
      asc(notebooks.id)
    )
    .limit(limit);

  return rows.map((row) => ({
    type: "lab_notebook" as const,
    id: row.id,
    name: row.name,
    url: row.url,
    runCount: row.runCount ?? 0,
  }));
}

async function searchFiles(
  query: string,
  limit: number
): Promise<SearchFileResult[]> {
  const escaped = escapeLike(query);
  const substring = `%${escaped}%`;
  const prefix = `${escaped}%`;

  const relevance = sql<number>`case when ${files.filename} ilike ${prefix} then 1 else 0 end`;

  const rows = await db
    .select({
      id: files.id,
      filename: files.filename,
      sizeBytes: files.sizeBytes,
      runId: instrumentRuns.runId,
      instrumentId: instrumentRuns.instrumentId,
      instrumentName: instruments.displayName,
    })
    .from(files)
    .innerJoin(instrumentRuns, eq(files.instrumentRunId, instrumentRuns.id))
    .innerJoin(instruments, eq(instrumentRuns.instrumentId, instruments.id))
    .where(
      and(
        isNull(files.deletedAt),
        isNull(instrumentRuns.deletedAt),
        ilike(files.filename, substring)
      )
    )
    .orderBy(desc(relevance), desc(files.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    type: "file" as const,
    id: row.id,
    filename: row.filename,
    sizeBytes: row.sizeBytes,
    runId: row.runId,
    instrumentId: row.instrumentId,
    instrumentName: row.instrumentName,
  }));
}

// Instruments are few (fleet-scale), and their file patterns live in watcher
// config YAML rather than a column, so matching happens in JS over the same
// pre-aggregated list the instruments page uses. A query matches an
// instrument by display name, id, or any configured file pattern.
async function searchInstruments(
  query: string,
  limit: number
): Promise<SearchInstrumentResult[]> {
  const needle = query.toLowerCase();
  const all = await getInstrumentListWithCounts();

  const matched = all
    .map((row) => {
      const nameHit =
        row.displayName.toLowerCase().includes(needle) ||
        row.id.toLowerCase().includes(needle);
      const matchedPattern = row.filePatterns.find((p) =>
        p.toLowerCase().includes(needle)
      );
      if (!(nameHit || matchedPattern)) {
        return null;
      }
      // Name/id is the instrument's identity — rank it above a pattern-only
      // match. A prefix hit on the name ranks highest.
      const prefixHit = row.displayName.toLowerCase().startsWith(needle);
      const relevance = nameHit ? (prefixHit ? 2 : 1) : 0;
      return {
        result: {
          type: "instrument" as const,
          id: row.id,
          displayName: row.displayName,
          status: row.status,
          connection: row.connection,
          watcherStatus: toLegacyWatcherStatus(row.connection),
          lastWatcherHeartbeatAt:
            row.watcher?.lastHeartbeatAt?.toISOString() ?? null,
          runCount: row.runCount,
          matchReason: nameHit ? ("name" as const) : ("pattern" as const),
          matchedPattern: nameHit ? null : (matchedPattern ?? null),
        },
        relevance,
        lastRunAt: row.lastRunAt?.getTime() ?? 0,
      };
    })
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .sort((a, b) => b.relevance - a.relevance || b.lastRunAt - a.lastRunAt)
    .slice(0, limit)
    .map((m) => m.result);

  return matched;
}

async function searchUsers(
  query: string,
  limit: number
): Promise<SearchUserResult[]> {
  const escaped = escapeLike(query);
  const substring = `%${escaped}%`;
  const prefix = `${escaped}%`;

  // Prefix on display name outranks email prefix, then any substring hit.
  const relevance = sql<number>`case
    when ${users.name} ilike ${prefix} then 2
    when ${users.email} ilike ${prefix} then 1
    else 0
  end`;

  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      image: users.image,
    })
    .from(users)
    .where(
      or(ilike(users.name, substring), ilike(users.email, substring)) as SQL
    )
    .orderBy(desc(relevance), asc(users.name), asc(users.email))
    .limit(limit);

  return rows.map((row) => ({
    type: "user" as const,
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
  }));
}

async function searchComments(
  query: string,
  limit: number
): Promise<SearchCommentResult[]> {
  const escaped = escapeLike(query);
  const substring = `%${escaped}%`;
  const prefix = `${escaped}%`;

  const relevance = sql<number>`case when ${runComments.body} ilike ${prefix} then 1 else 0 end`;

  const rows = await db
    .select({
      id: runComments.id,
      body: runComments.body,
      createdAt: runComments.createdAt,
      userId: users.id,
      userName: users.name,
      userEmail: users.email,
      tokenId: personalAccessTokens.id,
      tokenName: personalAccessTokens.name,
      tokenRevokedAt: personalAccessTokens.revokedAt,
      runId: instrumentRuns.runId,
      instrumentId: instrumentRuns.instrumentId,
      instrumentName: instruments.displayName,
    })
    .from(runComments)
    .innerJoin(instrumentRuns, eq(runComments.runId, instrumentRuns.id))
    .innerJoin(instruments, eq(instrumentRuns.instrumentId, instruments.id))
    // Left joins: a comment written by a token has no user, and a comment
    // whose author was deleted has neither. Neither should drop out of search.
    .leftJoin(users, eq(runComments.userId, users.id))
    .leftJoin(
      personalAccessTokens,
      eq(personalAccessTokens.id, runComments.tokenId)
    )
    .where(
      and(
        isNull(runComments.deletedAt),
        isNull(instrumentRuns.deletedAt),
        ilike(runComments.body, substring)
      )
    )
    .orderBy(desc(relevance), desc(runComments.createdAt))
    .limit(limit);

  return rows.map((row) => {
    const actor = resolveActor({
      userId: row.userId,
      userName: row.userName,
      userEmail: row.userEmail,
      userImage: null,
      tokenId: row.tokenId,
      tokenName: row.tokenName,
      tokenRevokedAt: row.tokenRevokedAt,
    });
    const user = actorUser(actor);
    return {
      type: "comment" as const,
      id: row.id,
      bodyPreview: commentBodyPreview(row.body, query),
      createdAt: row.createdAt.toISOString(),
      userId: user?.userId ?? null,
      userName: user?.displayName ?? null,
      token: actor?.kind === "token" ? actor.token : null,
      runId: row.runId,
      instrumentId: row.instrumentId,
      instrumentName: row.instrumentName,
    };
  });
}

function emptyResult(): GlobalSearchResult {
  return {
    runs: [],
    lab_notebooks: [],
    files: [],
    instruments: [],
    users: [],
    comments: [],
    counts: {
      runs: 0,
      lab_notebooks: 0,
      files: 0,
      instruments: 0,
      users: 0,
      comments: 0,
      total: 0,
    },
  };
}

export async function globalSearch({
  query,
  scope = "all",
}: {
  query: string;
  scope?: SearchScope;
}): Promise<GlobalSearchResult> {
  const trimmed = query.trim();

  if (trimmed.length < MIN_QUERY_LENGTH) {
    return emptyResult();
  }

  // How many results a group gets: a few of each on "All", more on its own
  // tab, and none on another group's tab.
  const limitFor = (group: Exclude<SearchScope, "all">): number => {
    if (scope === "all") {
      return ALL_TAB_PER_GROUP;
    }
    return scope === group ? SCOPED_LIMIT : 0;
  };
  const searchGroup = <T>(
    group: Exclude<SearchScope, "all">,
    search: (query: string, limit: number) => Promise<T[]>
  ): Promise<T[]> => {
    const limit = limitFor(group);
    return limit > 0 ? search(trimmed, limit) : Promise.resolve([]);
  };

  const [
    runs,
    notebooksResult,
    filesResult,
    instrumentsResult,
    usersResult,
    commentsResult,
  ] = await Promise.all([
    searchGroup("runs", searchRuns),
    searchGroup("lab_notebooks", searchNotebooks),
    searchGroup("files", searchFiles),
    searchGroup("instruments", searchInstruments),
    searchGroup("users", searchUsers),
    searchGroup("comments", searchComments),
  ]);

  return {
    runs,
    lab_notebooks: notebooksResult,
    files: filesResult,
    instruments: instrumentsResult,
    users: usersResult,
    comments: commentsResult,
    counts: {
      runs: runs.length,
      lab_notebooks: notebooksResult.length,
      files: filesResult.length,
      instruments: instrumentsResult.length,
      users: usersResult.length,
      comments: commentsResult.length,
      total:
        runs.length +
        notebooksResult.length +
        filesResult.length +
        instrumentsResult.length +
        usersResult.length +
        commentsResult.length,
    },
  };
}
