import { Skeleton } from "@/components/ui/skeleton";

// Placeholder for a page's title row. `withAction` reserves space for a
// trailing button (e.g. "Add instrument") so the header doesn't jump when the
// real controls render.
export function PageHeaderSkeleton({
  withAction = false,
}: {
  withAction?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <Skeleton className="h-8 w-48" />
      {withAction ? <Skeleton className="h-9 w-32" /> : null}
    </div>
  );
}
