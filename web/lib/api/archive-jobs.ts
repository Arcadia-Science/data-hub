import { and, eq, inArray, lt } from "drizzle-orm";
import { db as defaultDb } from "@/lib/db";
import { archiveJobs } from "@/lib/db/schema";

// How long an in-flight `archive_jobs` row is allowed to sit in
// `pending`/`building` before the next request treats it as dead and flips
// it to `failed`. Sized to comfortably exceed every legitimate completion
// path:
//
// - Lambda Function URL caps synchronous responses at 15 minutes, so a row
//   that's still `building` after 20 minutes can't have a live Lambda
//   behind it.
// - The route's `maxDuration` is 5 minutes, which bounds the inline-await
//   path.
// - The async path's `next/server` `after()` callback has the same ceiling
//   plus some platform-side grace.
//
// Without this expiry, a Lambda that crashes after `create_multipart_upload`
// but before the PATCH callback fires would poison the (run, fingerprint)
// pair forever — the partial unique index `WHERE status in ('pending',
// 'building')` keeps blocking new inserts until the row transitions, and
// nothing else moves it.
export const STUCK_BUILD_TIMEOUT_MS = 20 * 60 * 1000;

export const STUCK_BUILD_ERROR_MESSAGE =
  "Build did not report completion within the expected window; flagged as failed by a subsequent request.";

// Flips any stale `pending`/`building` rows for the given (run, fingerprint)
// pair to `failed`. Safe to call on every download-archive request: the WHERE
// clause skips healthy in-flight rows, so the steady-state cost is one
// no-op UPDATE per request. Returns the number of rows expired so callers
// can log/observe stuck-build incidents.
//
// The active healing approach (vs. just filtering the lookup) is deliberate
// — Postgres can't reference `now()` inside a partial index predicate, so
// the stale row will keep blocking the partial unique `INSERT` until it
// transitions out of the in-flight statuses. The cheapest way to keep the
// dedup behavior intact is to actually move the stale row to a terminal
// state.
//
// Accepts an optional `db` override so integration tests can drive this
// against their own connection (the default `@/lib/db` singleton reads
// `DATABASE_URL` at import time, which differs from the test DB).
export async function expireStaleArchiveJobs(
  runInternalId: string,
  fingerprint: string,
  options: { now?: Date; db?: typeof defaultDb } = {}
): Promise<number> {
  const now = options.now ?? new Date();
  const db = options.db ?? defaultDb;
  const cutoff = new Date(now.getTime() - STUCK_BUILD_TIMEOUT_MS);
  const expired = await db
    .update(archiveJobs)
    .set({
      status: "failed",
      errorMessage: STUCK_BUILD_ERROR_MESSAGE,
      completedAt: now,
    })
    .where(
      and(
        eq(archiveJobs.instrumentRunId, runInternalId),
        eq(archiveJobs.fingerprint, fingerprint),
        inArray(archiveJobs.status, ["pending", "building"]),
        lt(archiveJobs.createdAt, cutoff)
      )
    )
    .returning({ id: archiveJobs.id });
  return expired.length;
}
