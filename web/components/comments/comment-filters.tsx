import { CommentFilterPanel } from "@/components/comments/comment-filter-panel";
import { Skeleton } from "@/components/ui/skeleton";
import { listCommentInstrumentFacets } from "@/lib/api/run-comments";

export async function CommentFilters({
  authorId,
  currentUserId,
  includeIds,
  personLabel,
  ranBy,
}: {
  authorId: string | null;
  currentUserId: string;
  includeIds: string[];
  personLabel: string | null;
  ranBy: string | null;
}) {
  const instruments = await listCommentInstrumentFacets({
    authorId: authorId ?? undefined,
    includeIds,
    ranBy: ranBy ?? undefined,
  });

  return (
    <CommentFilterPanel
      currentUserId={currentUserId}
      instruments={instruments}
      personLabel={personLabel}
    />
  );
}

export function CommentFilterSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading filters"
      className="flex flex-col gap-7"
      role="status"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-12" />
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-9 w-48" />
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  );
}
