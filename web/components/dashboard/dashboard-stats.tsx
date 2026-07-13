import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatarLink } from "@/components/user-avatar";
import type {
  DashboardStats,
  MyRunsStats,
  TopAttributor,
} from "@/lib/api/dashboard";
import { cn, formatBytes } from "@/lib/utils";

const DASHBOARD_STAT_LABELS = [
  "Runs today",
  "Runs this week",
  "Pending uploads",
  "Most runs this week",
] as const;

const MY_RUNS_STAT_LABELS = [
  "Runs today",
  "Runs this week",
  "Comments on your runs",
  "Pending uploads",
] as const;

const numberFormatter = new Intl.NumberFormat("en-US");

function formatNumber(n: number): string {
  return numberFormatter.format(n);
}

// The leaderboard card shows only the given (first) name to keep the value
// compact next to the avatar; falls back to the full label when there's no
// whitespace to split on (e.g. an email-only display name).
function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] || displayName;
}

function StatCard({
  label,
  value,
  subline,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  subline: ReactNode;
  valueClassName?: string;
}) {
  return (
    <Card className="gap-2 py-4" size="sm">
      <div className="px-4">
        <p className="font-medium text-muted-foreground text-xs">{label}</p>
        <p
          className={cn(
            "mt-1.5 font-heading font-semibold text-2xl tabular-nums leading-none tracking-tight",
            valueClassName
          )}
        >
          {value}
        </p>
        <p className="mt-1.5 text-muted-foreground text-xs">{subline}</p>
      </div>
    </Card>
  );
}

function DataGeneratedSubline({
  bytes,
  emptyLabel,
}: {
  bytes: number;
  emptyLabel: string;
}) {
  if (bytes === 0) {
    return <span>{emptyLabel}</span>;
  }
  return <span>{formatBytes(bytes)} generated</span>;
}

export function StatCardsSkeleton({
  labels = DASHBOARD_STAT_LABELS,
}: {
  labels?: readonly string[];
} = {}) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading stats"
      className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4"
      role="status"
    >
      {labels.map((label) => (
        <Card className="gap-2 py-4" key={label} size="sm">
          <div className="px-4">
            <p className="font-medium text-muted-foreground text-xs">{label}</p>
            <Skeleton className="mt-1.5 h-6 w-10" />
            <Skeleton className="mt-1.5 h-4 w-full" />
          </div>
        </Card>
      ))}
    </div>
  );
}

export function MyRunsStatsCardsSkeleton() {
  return <StatCardsSkeleton labels={MY_RUNS_STAT_LABELS} />;
}

export function DashboardStatsCards({
  stats,
  topAttributor,
}: {
  stats: DashboardStats;
  topAttributor: TopAttributor | null;
}) {
  const { runsToday, pendingUploads, runsThisWeek } = stats;

  // Highlight pending uploads in red once a backlog forms — a non-zero queue
  // is a routine signal of attention, not an error.
  const pendingHasBacklog = pendingUploads.count > 0;

  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label={DASHBOARD_STAT_LABELS[0]}
        subline={
          <DataGeneratedSubline
            bytes={runsToday.bytesGenerated}
            emptyLabel="No data generated today"
          />
        }
        value={formatNumber(runsToday.total)}
      />
      <StatCard
        label={DASHBOARD_STAT_LABELS[1]}
        subline={
          <DataGeneratedSubline
            bytes={runsThisWeek.bytesGenerated}
            emptyLabel="No data generated this week"
          />
        }
        value={formatNumber(runsThisWeek.total)}
      />
      <StatCard
        label={DASHBOARD_STAT_LABELS[2]}
        subline={
          pendingUploads.count > 0
            ? `${formatBytes(pendingUploads.totalBytes)} queued`
            : "Upload queue is clear"
        }
        value={formatNumber(pendingUploads.count)}
        valueClassName={pendingHasBacklog ? "text-destructive" : undefined}
      />
      <StatCard
        label={DASHBOARD_STAT_LABELS[3]}
        subline={
          topAttributor
            ? `${formatNumber(topAttributor.runCount)} runs · ${formatBytes(topAttributor.bytesGenerated)} generated`
            : "No attributed runs this week"
        }
        value={
          topAttributor ? (
            <UserAvatarLink
              className="gap-2"
              size="sm"
              user={topAttributor.user}
            >
              <span className="truncate">
                {firstName(topAttributor.user.displayName)}
              </span>
            </UserAvatarLink>
          ) : (
            "—"
          )
        }
        // The leaderboard value is a name + avatar, not a number, so drop the
        // numeric sizing used by the count cards.
        valueClassName="text-xl"
      />
    </div>
  );
}

export function MyRunsStatsCards({
  stats,
  // Only the comments card is possessive; the page passes the third-person form
  // ("Comments on Nadia's runs") when viewing another member.
  commentsLabel = MY_RUNS_STAT_LABELS[2],
}: {
  stats: MyRunsStats;
  commentsLabel?: string;
}) {
  const { runsToday, runsThisWeek, commentsThisWeek, pendingUploads } = stats;

  const pendingHasBacklog = pendingUploads.count > 0;

  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label={MY_RUNS_STAT_LABELS[0]}
        subline={
          <DataGeneratedSubline
            bytes={runsToday.bytesGenerated}
            emptyLabel="No data generated today"
          />
        }
        value={formatNumber(runsToday.total)}
      />
      <StatCard
        label={MY_RUNS_STAT_LABELS[1]}
        subline={
          <DataGeneratedSubline
            bytes={runsThisWeek.bytesGenerated}
            emptyLabel="No data generated this week"
          />
        }
        value={formatNumber(runsThisWeek.total)}
      />
      <StatCard
        label={commentsLabel}
        subline={commentsThisWeek.count > 0 ? "this week" : "None this week"}
        value={formatNumber(commentsThisWeek.count)}
      />
      <StatCard
        label={MY_RUNS_STAT_LABELS[3]}
        subline={
          pendingUploads.count > 0
            ? `${formatBytes(pendingUploads.totalBytes)} queued`
            : "Upload queue is clear"
        }
        value={formatNumber(pendingUploads.count)}
        valueClassName={pendingHasBacklog ? "text-destructive" : undefined}
      />
    </div>
  );
}
