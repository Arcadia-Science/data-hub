// Bumps `instrument_runs.updated_at` after something on the run changes:
// a file write, a "Ran By" claim, or a comment. The runs table's "Last
// Updated" column reads that timestamp, and those writes happen in several
// modules, so they share this helper. Pass the caller's `DbExecutor` so the
// bump stays in the same transaction.

import { inArray } from "drizzle-orm";
import { type DbExecutor, db } from "@/lib/db";
import { instrumentRuns } from "@/lib/db/schema";

export async function touchRuns(
  runIds: readonly string[],
  executor: DbExecutor = db
): Promise<void> {
  const unique = [...new Set(runIds)];
  if (unique.length === 0) {
    return;
  }
  await executor
    .update(instrumentRuns)
    .set({ updatedAt: new Date() })
    .where(inArray(instrumentRuns.id, unique));
}
