import { RunCommentsList } from "@/components/runs/run-comments-list";
import { Card, CardContent } from "@/components/ui/card";
import type { RunCommentDto } from "@/lib/api/run-comments";

// Server component. The page fetches `initialComments` in parallel with
// the rest of the run-detail data (per `server-parallel-fetching`) and
// hands them in here, so this component itself is pure presentation.
//
// Layout matches the other run-detail sections (Report Data, Files): the
// heading sits outside the card with an inline file/comment count.
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
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">
        Comments
        {comments.length > 0 && (
          <span className="ml-1 font-mono text-xs font-normal text-muted-foreground">
            {comments.length}
          </span>
        )}
      </h2>
      <Card size="sm">
        <CardContent>
          <RunCommentsList
            instrumentId={instrumentId}
            runId={runId}
            initialComments={comments}
          />
        </CardContent>
      </Card>
    </div>
  );
}
