import { Badge } from "@/components/ui/badge";
import type { RunListRow } from "@/lib/api/instrument-runs";

import { RunCommentCount } from "./run-comment-count";
import { RunIdLabel } from "./run-id-label";
import { RunStatusIcon } from "./run-status-icon";

export function RunIdCell({ href, run }: { href: string; run: RunListRow }) {
  const isDeleted = run.deleted_at !== null;

  return (
    <div className="flex items-center gap-2.5">
      <RunStatusIcon run={run} />
      <div className="flex min-w-0 items-center gap-2.5">
        <RunIdLabel href={href} isDeleted={isDeleted} runId={run.run_id} />
        <RunCommentCount count={run.comment_count} />
      </div>
      {isDeleted ? (
        <Badge className="ml-1.5 font-normal" variant="outline">
          deleted
        </Badge>
      ) : null}
    </div>
  );
}
