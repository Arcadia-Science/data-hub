import { type SQL, sql } from "drizzle-orm";
import { instrumentRuns, runAttributions } from "@/lib/db/schema";

// Correlated EXISTS against `run_attributions`, matching the `ranBy` predicate
// used by `buildRunListQuery` so comment feeds and "My runs" cards count the
// same runs the tables list.
export function attributedToUser(userId: string): SQL {
  return sql`exists (select 1 from ${runAttributions} where ${runAttributions.runId} = ${instrumentRuns.id} and ${runAttributions.userId} = ${userId})`;
}
