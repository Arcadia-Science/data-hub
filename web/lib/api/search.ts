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
import {
  getWatcherOnlineStatus,
  type WatcherOnlineStatus,
} from "@/components/watchers/watcher-online-status";
import { getInstrumentListWithCounts } from "@/lib/api/instruments";
import { db } from "@/lib/db";
import {
  files,
  instrumentRuns,
  instruments,
  runAttributions,
  runComments,
  users,
} from "@/lib/db/schema";
import { MIN_QUERY_LENGTH } from "@/lib/search-constants";

// Global search across top-level entities. Backed by the pg_trgm GIN indexes
// so the `ilike '%…%'` scans stay fast as the run/file/comment tables grow.

export type SearchScope =
  | "all"
  | "runs"
  | "files"
  | "instruments"
  | "users"
  | "comments";

// Per-group cap when searching everything at once ("All" tab). Matches the
// mockups. A scoped search (single tab) uses SCOPED_LIMIT so "Show all"
// surfaces a longer list without a dedicated results page.
const ALL_TAB_PER_GROUP = 5;
const SCOPED_LIMIT = 25;

// Short plain-text snippet for the ⌘K list — full body is matched in SQL.
const COMMENT_PREVIEW_MAX = 120;

// Why a run surfaced. `run_id` is the run's own title (highest relevance);
// `file` means a contained filename matched (drives the "Contains …" line);
// `instrument`/`ran_by` are secondary metadata matches.
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
  displayName: string;
  id: string;
  lastWatcherHeartbeatAt: string | null;
  // Set only when `matchReason` is "pattern" — the configured pattern that
  // matched (e.g. "*.nd2"), so the client can highlight it.
  matchedPattern: string | null;
  matchReason: InstrumentMatchReason;
  runCount: number;
  status: "pending" | "active" | "inactive";
  type: "instrument";
  // `deregistered` (active instrument, only watcher deregistered) is distinct
  // from `no_watcher`. Only meaningful when `status` is `active`.
  watcherStatus: WatcherOnlineStatus | "deregistered";
}

export interface SearchUserResult {
  email: string | null;
  id: string;
  image: string | null;
  name: string | null;
  type: "user";
}

export interface SearchCommentResult {
  bodyPreview: string;
  createdAt: string;
  id: string;
  instrumentId: string;
  instrumentName: string;
  runId: string;
  type: "comment";
  userId: string;
  userName: string;
}

export interface GlobalSearchResult {
  comments: SearchCommentResult[];
  counts: {
    comments: number;
    files: number;
    instruments: number;
    runs: number;
    // Sum of the *visible* (capped) results — this is the "N results for …"
    // figure the header shows, matching what the user actually sees.
    total: number;
    users: number;
  };
  files: SearchFileResult[];
  instruments: SearchInstrumentResult[];
  runs: SearchRunResult[];
  users: SearchUserResult[];
}

// Escapes LIKE wildcards so user input matches literally. A filename like
// `.*jpg` or a pattern query must be treated as text, never as a LIKE/regex
// pattern. Mirrors the escaping already used in `buildRunListQuery`.
function escapeLike(query: string): string {
  return query.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function commentBodyPreview(body: string): string {
  const collapsed = body.replace(/\s+/g, " ").trim();
  if (collapsed.length <= COMMENT_PREVIEW_MAX) {
    return collapsed;
  }
  return `${collapsed.slice(0, COMMENT_PREVIEW_MAX).trimEnd()}…`;
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

  // Relevance: a prefix hit on the run id (the title) outranks any substring
  // hit, which outranks a metadata-only match; recency breaks ties.
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
    // Precedence: title match first, then a nested-file match (worth its own
    // "Contains …" line), then instrument, then attribution.
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
          watcherStatus:
            row.watcherCount === 0 && row.hasDeregisteredWatcher
              ? ("deregistered" as const)
              : getWatcherOnlineStatus(row),
          lastWatcherHeartbeatAt: row.lastWatcherHeartbeatAt
            ? row.lastWatcherHeartbeatAt.toISOString()
            : null,
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
      runId: instrumentRuns.runId,
      instrumentId: instrumentRuns.instrumentId,
      instrumentName: instruments.displayName,
    })
    .from(runComments)
    .innerJoin(instrumentRuns, eq(runComments.runId, instrumentRuns.id))
    .innerJoin(instruments, eq(instrumentRuns.instrumentId, instruments.id))
    .innerJoin(users, eq(runComments.userId, users.id))
    .where(
      and(
        isNull(runComments.deletedAt),
        isNull(instrumentRuns.deletedAt),
        ilike(runComments.body, substring)
      )
    )
    .orderBy(desc(relevance), desc(runComments.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    type: "comment" as const,
    id: row.id,
    bodyPreview: commentBodyPreview(row.body),
    createdAt: row.createdAt.toISOString(),
    userId: row.userId,
    userName: row.userName ?? row.userEmail ?? "Unknown",
    runId: row.runId,
    instrumentId: row.instrumentId,
    instrumentName: row.instrumentName,
  }));
}

function emptyResult(): GlobalSearchResult {
  return {
    runs: [],
    files: [],
    instruments: [],
    users: [],
    comments: [],
    counts: {
      runs: 0,
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

  const runLimit =
    scope === "all" ? ALL_TAB_PER_GROUP : scope === "runs" ? SCOPED_LIMIT : 0;
  const fileLimit =
    scope === "all" ? ALL_TAB_PER_GROUP : scope === "files" ? SCOPED_LIMIT : 0;
  const instrumentLimit =
    scope === "all"
      ? ALL_TAB_PER_GROUP
      : scope === "instruments"
        ? SCOPED_LIMIT
        : 0;
  const userLimit =
    scope === "all" ? ALL_TAB_PER_GROUP : scope === "users" ? SCOPED_LIMIT : 0;
  const commentLimit =
    scope === "all"
      ? ALL_TAB_PER_GROUP
      : scope === "comments"
        ? SCOPED_LIMIT
        : 0;

  const [runs, filesResult, instrumentsResult, usersResult, commentsResult] =
    await Promise.all([
      runLimit > 0 ? searchRuns(trimmed, runLimit) : Promise.resolve([]),
      fileLimit > 0 ? searchFiles(trimmed, fileLimit) : Promise.resolve([]),
      instrumentLimit > 0
        ? searchInstruments(trimmed, instrumentLimit)
        : Promise.resolve([]),
      userLimit > 0 ? searchUsers(trimmed, userLimit) : Promise.resolve([]),
      commentLimit > 0
        ? searchComments(trimmed, commentLimit)
        : Promise.resolve([]),
    ]);

  return {
    runs,
    files: filesResult,
    instruments: instrumentsResult,
    users: usersResult,
    comments: commentsResult,
    counts: {
      runs: runs.length,
      files: filesResult.length,
      instruments: instrumentsResult.length,
      users: usersResult.length,
      comments: commentsResult.length,
      total:
        runs.length +
        filesResult.length +
        instrumentsResult.length +
        usersResult.length +
        commentsResult.length,
    },
  };
}
