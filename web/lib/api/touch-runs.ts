// Bumps `instrument_runs.updated_at` after a file in the run changes.
// The runs table's "Last Updated" column reads that timestamp, and file
// writes happen in several modules, so they share this helper. Pass the
// caller's `DbExecutor` so the bump stays in the same transaction.

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
