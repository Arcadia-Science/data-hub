import {
  RunCommentsSkeleton,
  RunContentSkeleton,
} from "@/components/runs/run-detail-skeleton";

export default function RunDetailLoading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <RunContentSkeleton instrumentType="generic" />
      <RunCommentsSkeleton />
    </div>
  );
}
