import type { ReactNode } from "react";
import type { RunListRow } from "@/lib/api/instrument-runs";

import { RunCommentCount } from "./run-comment-count";
import { RunIdLabel } from "./run-id-label";
import { RunStatusIcon } from "./run-status-icon";

export function RunIdCell({
  children,
  href,
  labelClassName,
  run,
}: {
  children?: ReactNode;
  href: string;
  labelClassName?: string;
  run: RunListRow;
}) {
  return (
    <div className="flex items-center gap-2.5">
      <RunStatusIcon run={run} />
      <div className="flex min-w-0 items-center gap-2.5">
        <RunIdLabel
          className={labelClassName}
          href={href}
          isDeleted={run.deleted_at !== null}
          runId={run.run_id}
        />
        <RunCommentCount count={run.comment_count} />
      </div>
      {children}
    </div>
  );
}
