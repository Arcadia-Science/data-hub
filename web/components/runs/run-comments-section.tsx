import { RunCommentsList } from "@/components/runs/run-comments-list";
import type { RunCommentDto } from "@/lib/api/run-comments";

// Server component. The page fetches comments in parallel with the rest
// of the run-detail data (per `server-parallel-fetching`) and hands them
// in here. The heading lives inside `RunCommentsList` so the count can
// track optimistic create/delete.
export function RunCommentsSection({
  instrumentId,
  runId,
  comments,
}: {
  instrumentId: string;
  runId: string;
  comments: RunCommentDto[];
}) {
  return (
    <RunCommentsList
      initialComments={comments}
      instrumentId={instrumentId}
      runId={runId}
    />
  );
}
