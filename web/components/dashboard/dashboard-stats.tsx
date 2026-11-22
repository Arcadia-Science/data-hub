import Link from "next/link";
import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatarLink } from "@/components/user-avatar";
import type {
  DashboardStats,
  MyRunsStats,
  TopAttributor,
} from "@/lib/api/dashboard";
import { firstName } from "@/lib/display-name";
import { runsNeedingAttentionHref } from "@/lib/runs/attention-href";
import {
  NEEDS_ATTENTION_RUN_STATUSES,
  RUN_STATUS_META,
  type RunsNeedingAttention,
} from "@/lib/runs/run-status";
import { cn, formatBytes } from "@/lib/utils";

const DASHBOARD_STAT_LABELS = [
  "Runs today",
  "Runs this week",
  "Runs needing attention",
  "Most runs this week",
] as const;

const MY_RUNS_STAT_LABELS = [
  "Runs this week",
  "Lab notebooks this week",
  "Comments on your runs",
  "Runs needing attention",
] as const;

const numberFormatter = new Intl.NumberFormat("en-US");

function formatNumber(n: number): string {
  return numberFormatter.format(n);
}

function StatCard({
  label,
  value,
  subline,
  valueClassName,
  href,
}: {
  label: string;
  value: ReactNode;
  subline: ReactNode;
  valueClassName?: string;
  // Makes the whole card a link, for a card that counts things to look at.
  href?: string;
}) {
  const card = (
    <Card
      className={cn(
        "gap-2 py-4",
        href && "h-full transition-colors group-hover:bg-muted/50"
      )}
      size="sm"
    >
      <div className="px-4">
        <p className="font-medium text-muted-foreground text-xs">{label}</p>
        <p
          className={cn(
            // `h-7` matches the leaderboard avatar (`size-sm`) so every value
            // row shares one height and the sublines stay aligned.
            "mt-1.5 flex h-7 items-center font-heading font-semibold text-2xl tabular-nums leading-none tracking-tight",
            valueClassName
          )}
        >
          {value}
        </p>
        <p className="mt-1.5 text-muted-foreground text-xs">{subline}</p>
      </div>
    </Card>
  );
  if (!href) {
    return card;
  }
  return (
    <Link
      className="group rounded-xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      href={href}
    >
      {card}
    </Link>
  );
}

const ATTENTION_COUNT_FIELD = {
  upload_failed: "uploadFailed",
  failed: "failed",
  stalled: "stalled",
} as const satisfies Record<
  (typeof NEEDS_ATTENTION_RUN_STATUSES)[number],
  keyof RunsNeedingAttention
>;

// "Runs needing attention": failed uploads, failed processing and stalled
// processing, each a run status someone has to act on. Links to the runs list
// filtered to those statuses while there are any.
function RunsNeedingAttentionCard({
  counts,
  href,
  label,
}: {
  counts: RunsNeedingAttention;
  href: string;
  label: string;
}) {
  const parts = NEEDS_ATTENTION_RUN_STATUSES.flatMap((status) => {
    const count = counts[ATTENTION_COUNT_FIELD[status]];
    return count > 0
      ? [
          `${formatNumber(count)} ${RUN_STATUS_META[status].label.toLowerCase()}`,
        ]
      : [];
  });
  return (
    <StatCard
      href={counts.total > 0 ? href : undefined}
      label={label}
      subline={parts.length > 0 ? parts.join(" · ") : "Nothing needs attention"}
      value={formatNumber(counts.total)}
      valueClassName={counts.total > 0 ? "text-destructive" : undefined}
    />
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
            <Skeleton className="mt-1.5 h-7 w-10" />
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
  const { runsToday, runsNeedingAttention, runsThisWeek } = stats;

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
      <RunsNeedingAttentionCard
        counts={runsNeedingAttention}
        href={runsNeedingAttentionHref()}
        label={DASHBOARD_STAT_LABELS[2]}
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
  userId,
}: {
  stats: MyRunsStats;
  commentsLabel?: string;
  // Whose runs these are, for the "Runs needing attention" link.
  userId: string;
}) {
  const {
    runsThisWeek,
    notebooksThisWeek,
    commentsThisWeek,
    runsNeedingAttention,
  } = stats;

  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label={MY_RUNS_STAT_LABELS[0]}
        subline={
          <DataGeneratedSubline
            bytes={runsThisWeek.bytesGenerated}
            emptyLabel="No data generated this week"
          />
        }
        value={formatNumber(runsThisWeek.total)}
      />
      {/* The lab notebooks this person owns that got a run this week. */}
      <StatCard
        label={MY_RUNS_STAT_LABELS[1]}
        subline={
          notebooksThisWeek.owned > 0
            ? `of ${formatNumber(notebooksThisWeek.owned)} owned`
            : "None owned"
        }
        value={formatNumber(notebooksThisWeek.count)}
      />
      <StatCard
        label={commentsLabel}
        subline={commentsThisWeek.count > 0 ? "this week" : "None this week"}
        value={formatNumber(commentsThisWeek.count)}
      />
      <RunsNeedingAttentionCard
        counts={runsNeedingAttention}
        href={runsNeedingAttentionHref(userId)}
        label={MY_RUNS_STAT_LABELS[3]}
      />
    </div>
  );
}
