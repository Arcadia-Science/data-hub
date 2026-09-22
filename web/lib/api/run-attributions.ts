// Claim/unclaim writes shared by the REST attributions route and the MCP
// claim tools. A "Ran By" change moves the run's "Last Updated" time, the
// same as a file change; a no-op repeat (re-claim, unclaiming a run the
// user never claimed) stores nothing and leaves the time alone, matching
// the repeat-report rule in `recordDetectedFiles`.

import { and, eq, inArray } from "drizzle-orm";
import { touchRuns } from "@/lib/api/touch-runs";
import { db } from "@/lib/db";
import { runAttributions } from "@/lib/db/schema";

export async function claimRuns(
  runIds: readonly string[],
  userId: string
): Promise<void> {
  const unique = [...new Set(runIds)];
  if (unique.length === 0) {
    return;
  }
  const inserted = await db
    .insert(runAttributions)
    .values(unique.map((runId) => ({ runId, userId })))
    .onConflictDoNothing()
    .returning({ runId: runAttributions.runId });
  await touchRuns(inserted.map((row) => row.runId));
}

export async function unclaimRuns(
  runIds: readonly string[],
  userId: string
): Promise<void> {
  const unique = [...new Set(runIds)];
  if (unique.length === 0) {
    return;
  }
  const deleted = await db
    .delete(runAttributions)
    .where(
      and(
        inArray(runAttributions.runId, unique),
        eq(runAttributions.userId, userId)
      )
    )
    .returning({ runId: runAttributions.runId });
  await touchRuns(deleted.map((row) => row.runId));
}
