import { Card, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { RunDetail } from "@/lib/api/instrument-runs";

export function RunHeaderSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="mb-2 h-4 w-72" />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Skeleton className="h-8 w-72" />
        <div className="flex items-center gap-2">
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="h-8 w-24 rounded-md" />
        </div>
      </div>
    </div>
  );
}

function RunMetadataSkeleton() {
  return (
    <div className="rounded-lg border bg-background dark:bg-muted">
      <div className="flex flex-wrap gap-x-8 gap-y-4 px-4 py-3">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-10" />
          <Skeleton className="h-5 w-6" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-10" />
          <Skeleton className="h-5 w-14" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-5 w-12" />
          <div className="flex h-5 items-center gap-1.5">
            <Skeleton className="size-5 rounded-full" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      </div>
      <Separator />
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3.5 w-40" />
        <Skeleton className="h-3.5 w-40" />
      </div>
    </div>
  );
}

function RunFilesSectionSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="font-semibold text-sm">Files</h2>
      <div className="rounded-lg border bg-background dark:bg-muted">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <div className="relative min-w-0 flex-1">
            <Skeleton className="h-8 w-full" />
          </div>
          <Skeleton className="h-8 w-24 shrink-0" />
          <Skeleton className="h-8 w-28 shrink-0" />
          <Skeleton className="h-8 w-36 shrink-0" />
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10 pr-0 pl-3" />
              <TableHead>File name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Created</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: rows }).map((_, i) => (
              <TableRow key={i}>
                <TableCell className="pr-0 pl-3">
                  <Skeleton className="size-4" />
                </TableCell>
                <TableCell className="py-2">
                  <Skeleton className="h-4 w-32" />
                </TableCell>
                <TableCell className="py-2">
                  <Skeleton className="h-5 w-16 rounded-full" />
                </TableCell>
                <TableCell className="py-2">
                  <Skeleton className="h-4 w-12" />
                </TableCell>
                <TableCell className="py-2">
                  <Skeleton className="h-4 w-28" />
                </TableCell>
                <TableCell className="py-2">
                  <Skeleton className="h-5 w-20 rounded-full" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="flex items-center justify-between gap-2 border-t px-3 py-2">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-40" />
        </div>
      </div>
    </div>
  );
}

function showsReportSection(instrumentType: RunDetail["instrumentType"]) {
  return (
    instrumentType !== "plate_reader" &&
    instrumentType !== "instant_raman" &&
    instrumentType !== "aunty"
  );
}

function RunReportSectionSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <h2 className="font-semibold text-sm">Report Data</h2>
      <Card size="sm">
        <CardContent>
          <Skeleton className="h-5 w-72 max-w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

export function RunContentSkeleton({
  instrumentType,
}: {
  instrumentType: RunDetail["instrumentType"];
}) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading run"
      className="flex flex-col gap-6"
      role="status"
    >
      <RunHeaderSkeleton />
      <div className="flex min-w-0 flex-col gap-4">
        <RunMetadataSkeleton />
        <RunFilesSectionSkeleton />
      </div>
      {showsReportSection(instrumentType) ? <RunReportSectionSkeleton /> : null}
    </div>
  );
}

export function RunCommentsSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading comments"
      className="flex flex-col gap-2"
      role="status"
    >
      <h2 className="font-semibold text-sm">Comments</h2>
      <Card className="gap-0 py-0" size="sm">
        <div className="flex flex-col divide-y divide-border">
          <div className="px-4 py-4 first:pt-1 last:pb-1">
            <div className="flex gap-3">
              <Skeleton className="mt-0.5 size-6 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-start justify-between gap-2">
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="size-7 shrink-0 rounded-md" />
                </div>
                <Skeleton className="h-4 w-full max-w-md" />
              </div>
            </div>
          </div>
          <div className="px-4 py-4">
            <Skeleton className="h-20 w-full rounded-md" />
          </div>
        </div>
      </Card>
    </div>
  );
}
