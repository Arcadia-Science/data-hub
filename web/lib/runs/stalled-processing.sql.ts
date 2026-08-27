import { type SQL, sql } from "drizzle-orm";
import { files } from "@/lib/db/schema";
import { stalledProcessingCutoff } from "@/lib/runs/stalled-processing";

// SQL twins of `isStalledProcessing`, kept in their own module so client
// bundles that only need the predicate don't pull in Drizzle and the schema.
//
// The two fragments partition `processing` exactly: a row is either stalled or
// in flight, never both and never neither. Keep the comparisons complementary
// (`<` and `>=`) or a row landing precisely on the cutoff disappears from both.

export function stalledProcessingSql(now: Date = new Date()): SQL {
  const cutoff = stalledProcessingCutoff(now);
  return sql`(${files.status} = 'processing' and (${files.processingStartedAt} is null or ${files.processingStartedAt} < ${cutoff}))`;
}

export function inFlightProcessingSql(now: Date = new Date()): SQL {
  const cutoff = stalledProcessingCutoff(now);
  return sql`(${files.status} = 'processing' and ${files.processingStartedAt} is not null and ${files.processingStartedAt} >= ${cutoff})`;
}
