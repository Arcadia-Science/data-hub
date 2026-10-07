import Link from "next/link";
import { RelativeTime } from "@/components/dashboard/relative-time";
import {
  FeedbackLabelChip,
  FeedbackPriority,
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
import { UserAvatar } from "@/components/user-avatar";
import { toUserAvatarUser } from "@/lib/avatar-color";
import type { FeedbackTab } from "@/lib/search-params";

export interface FeedbackTableGroup {
  color: string;
  count: number;
  name: string;
  stateId: string;
}

export interface FeedbackTableRow {
  assignee: {
    avatarUrl: string | null;
    name: string;
    userId: string;
  } | null;
  createdAt: string;
  id: string;
  identifier: string;
  labels: { color: string; name: string }[];
  priority: number | null;
  priorityLabel: string | null;
  reporterLabel: string;
  stateColor: string;
  stateId: string;
  title: string;
}

const COLUMNS = 7;

export function FeedbackTableSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading feedback"
      className="overflow-hidden rounded-lg border bg-background dark:bg-muted"
      role="status"
    >
      <Table className="min-w-[64rem] table-fixed">
        <FeedbackColumns />
        <TableBody>
          {Array.from({ length: 4 }).map((_, index) => (
            <TableRow key={index}>
              {Array.from({ length: COLUMNS }).map((__, cell) => (
                <TableCell key={cell}>
                  <Skeleton className="h-4 w-16" />
                </TableCell>
              ))}
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
        <TableHead className="w-28">ID</TableHead>
        <TableHead>Title</TableHead>
        <TableHead className="w-40">Label</TableHead>
        <TableHead className="w-32">Priority</TableHead>
        <TableHead className="w-44">Reporter</TableHead>
        <TableHead className="w-28">Assignee</TableHead>
        <TableHead className="w-28">Sent</TableHead>
      </TableRow>
    </TableHeader>
  );
}

export function FeedbackTable({
  groups,
  hrefFor,
  rows,
  selectedId,
  status,
}: {
  groups: FeedbackTableGroup[];
  hrefFor: (id: string) => string;
  rows: FeedbackTableRow[];
  selectedId: string | null;
  status: FeedbackTab;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed bg-background py-16 text-center dark:bg-muted">
        <p className="font-medium text-sm">No {status} feedback</p>
        <p className="mt-1 text-muted-foreground text-sm">
          Reports sent from the app or an agent show up here.
        </p>
      </div>
    );
  }

  const groupById = new Map(groups.map((group) => [group.stateId, group]));
  let previousStateId: string | null = null;

  return (
    <div className="overflow-hidden rounded-lg border bg-background dark:bg-muted">
      <Table className="min-w-[64rem] table-fixed">
        <FeedbackColumns />
        <TableBody>
          {rows.map((row) => {
            const showGroup = row.stateId !== previousStateId;
            previousStateId = row.stateId;
            const group = groupById.get(row.stateId);
            return (
              <FeedbackRows
                group={
                  showGroup
                    ? (group ?? {
                        stateId: row.stateId,
                        name: "Status",
                        color: row.stateColor,
                        count: 1,
                      })
                    : null
                }
                href={hrefFor(row.id)}
                key={row.id}
                row={row}
                selected={row.id === selectedId}
              />
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function FeedbackRows({
  group,
  href,
  row,
  selected,
}: {
  group: FeedbackTableGroup | null;
  href: string;
  row: FeedbackTableRow;
  selected: boolean;
}) {
  const firstLabel = row.labels[0];
  const extraLabels = Math.max(0, row.labels.length - 1);
  return (
    <>
      {group ? (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
          <TableCell className="py-2" colSpan={COLUMNS}>
            <span className="inline-flex items-center gap-2 font-medium text-sm">
              <span
                aria-hidden="true"
                className="size-2 rounded-full"
                style={{ backgroundColor: group.color }}
              />
              {group.name}
              <span className="font-normal text-muted-foreground tabular-nums">
                {group.count}
              </span>
            </span>
          </TableCell>
        </TableRow>
      ) : null}
      <TableRow
        className="relative cursor-pointer"
        data-state={selected ? "selected" : undefined}
      >
        <TableCell className="font-mono text-muted-foreground text-xs">
          <Link
            aria-label={row.title}
            className="absolute inset-0 z-10"
            href={href}
          />
          {row.identifier}
        </TableCell>
        <TableCell className="max-w-0 overflow-hidden">
          <span className="block min-w-0 truncate font-medium">
            {row.title}
          </span>
        </TableCell>
        <TableCell>
          {firstLabel ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <FeedbackLabelChip
                color={firstLabel.color}
                name={firstLabel.name}
              />
              {extraLabels > 0 ? (
                <span className="text-muted-foreground text-xs">
                  +{extraLabels}
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </TableCell>
        <TableCell>
          <FeedbackPriority label={row.priorityLabel} priority={row.priority} />
        </TableCell>
        <TableCell className="max-w-0 overflow-hidden truncate text-muted-foreground">
          {row.reporterLabel}
        </TableCell>
        <TableCell>
          <Assignee assignee={row.assignee} />
        </TableCell>
        <TableCell className="text-muted-foreground tabular-nums">
          <RelativeTime date={row.createdAt} />
        </TableCell>
      </TableRow>
    </>
  );
}

function Assignee({ assignee }: { assignee: FeedbackTableRow["assignee"] }) {
  if (!assignee) {
    return (
      <span
        aria-label="Unassigned"
        className="inline-flex size-6 items-center justify-center rounded-full border border-dashed"
        role="img"
      />
    );
  }
  const user = toUserAvatarUser({
    userId: assignee.userId,
    name: assignee.name,
    image: assignee.avatarUrl,
  });
  return <UserAvatar aria-label={assignee.name} size="sm" user={user} />;
}
