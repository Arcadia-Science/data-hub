import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

function VersionFieldSkeleton({
  labelWidth = "w-32",
  descriptionLines = 2,
}: {
  labelWidth?: string;
  descriptionLines?: 1 | 2;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Skeleton className={`h-4 ${labelWidth}`} />
      <Skeleton className="h-9 w-full" />
      {descriptionLines === 2 ? (
        <>
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </>
      ) : (
        <Skeleton className="h-4 w-96" />
      )}
    </div>
  );
}

function MandatoryUpdateFieldSkeleton() {
  return (
    <div className="flex w-full flex-row items-start gap-3">
      <div className="flex min-w-0 flex-auto flex-col gap-1.5">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-4/5" />
      </div>
      <Skeleton className="h-5 w-8 shrink-0 rounded-full" />
    </div>
  );
}

/** Mirrors `WatcherReleaseForm` so streamed settings swap in without layout shift. */
export function WatcherReleaseFormSkeleton() {
  return (
    <Card
      aria-busy="true"
      aria-label="Loading watcher release settings"
      role="status"
    >
      <CardContent>
        <div className="flex flex-col gap-7">
          <VersionFieldSkeleton labelWidth="w-28" />
          <VersionFieldSkeleton labelWidth="w-44" />
          <VersionFieldSkeleton descriptionLines={1} labelWidth="w-28" />
          <MandatoryUpdateFieldSkeleton />
        </div>
      </CardContent>
      <CardFooter className="border-t">
        <div className="flex w-full items-center justify-between gap-4">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-9 w-16" />
        </div>
      </CardFooter>
    </Card>
  );
}
