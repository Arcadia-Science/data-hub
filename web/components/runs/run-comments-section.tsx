import { RunCommentsList } from "@/components/runs/run-comments-list";
import { RunSectionHeading } from "@/components/runs/run-section-heading";
import type { RunCommentDto } from "@/lib/api/run-comments";

// Server component. The page fetches `initialComments` in parallel with
// the rest of the run-detail data (per `server-parallel-fetching`) and
// hands them in here, so this component itself is pure presentation.
//
// Layout matches the other run-detail sections (Report Data, Files): the
// heading sits outside the card stack with an inline count in the form
// "Comments (N)".
// Each comment and the new-comment form get their own card inside
// `RunCommentsList` to match the conversational stacked-cards design.
// The whole stack is capped to half the container width so prose
// doesn't sprawl across wide screens.
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
      <RunSectionHeading countLabel={comments.length} title="Comments" />
      <div>
        <RunCommentsList
          initialComments={comments}
          instrumentId={instrumentId}
          runId={runId}
        />
      </div>
    </div>
  );
}
