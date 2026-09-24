import Link from "next/link";
import {
  FeedbackKindBadge,
  feedbackStatusLabel,
} from "@/components/feedback/feedback-badges";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { FeedbackKind, FeedbackStatus } from "@/lib/api/feedback-schema";
import { formatDateTime } from "@/lib/date";

export interface FeedbackTableRow {
  createdAt: string;
  id: string;
  kind: FeedbackKind;
  reporterLabel: string;
  sourceLabel: string;
  title: string;
}

export function FeedbackTableSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading feedback"
      className="overflow-hidden rounded-lg border bg-background dark:bg-muted"
      role="status"
    >
      <Table className="table-fixed">
        <FeedbackColumns />
        <TableBody>
          {Array.from({ length: 4 }).map((_, index) => (
            <TableRow key={index}>
              <TableCell>
                <Skeleton className="h-5 w-16" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-40 max-w-full" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-16" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-28" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function FeedbackColumns() {
  return (
    <TableHeader>
      <TableRow>
        <TableHead className="w-36">Type</TableHead>
        <TableHead>Title</TableHead>
        <TableHead className="w-40">Reporter</TableHead>
        <TableHead className="w-32">Source</TableHead>
        <TableHead className="w-44">Sent</TableHead>
      </TableRow>
    </TableHeader>
  );
}

export function FeedbackTable({
  hrefFor,
  rows,
  status,
}: {
  hrefFor: (id: string) => string;
  rows: FeedbackTableRow[];
  status: FeedbackStatus;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-background py-16 text-center dark:bg-muted">
        <p className="font-medium text-sm">
          No {feedbackStatusLabel(status).toLowerCase()} feedback
        </p>
        <p className="mt-1 text-muted-foreground text-sm">
          Reports sent from the app or an agent show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-background dark:bg-muted">
      <Table className="table-fixed">
        <FeedbackColumns />
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell>
                <FeedbackKindBadge kind={row.kind} />
              </TableCell>
              <TableCell className="max-w-0">
                <Link
                  className="block min-w-0 truncate font-medium hover:underline"
                  href={hrefFor(row.id)}
                >
                  {row.title}
                </Link>
              </TableCell>
              <TableCell className="max-w-0 truncate text-muted-foreground">
                {row.reporterLabel}
              </TableCell>
              <TableCell className="max-w-0 truncate text-muted-foreground">
                <span translate="no">{row.sourceLabel}</span>
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                <time dateTime={row.createdAt}>
                  {formatDateTime(new Date(row.createdAt))}
                </time>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
