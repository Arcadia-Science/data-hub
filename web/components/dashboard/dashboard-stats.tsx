import { Card } from "@/components/ui/card";
import type { DashboardStats } from "@/lib/api/dashboard";
import { cn, formatBytes } from "@/lib/utils";
import type { ReactNode } from "react";

const numberFormatter = new Intl.NumberFormat("en-US");

function formatNumber(n: number): string {
  return numberFormatter.format(n);
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
    <Card size="sm" className="gap-2 py-4">
      <div className="px-4">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p
          className={cn(
            "mt-1.5 font-heading text-2xl leading-none font-semibold tracking-tight tabular-nums",
            valueClassName
          )}
        >
          {value}
        </p>
        <p className="mt-1.5 text-xs text-muted-foreground">{subline}</p>
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
  return (
    <>
      <span>{formatBytes(bytes)} generated</span>
    </>
  );
}

export function DashboardStatsCards({ stats }: { stats: DashboardStats }) {
  const { runsLast24Hours, pendingUploads, runsThisWeek } = stats;

  // Highlight pending uploads in red once a backlog forms — a non-zero queue
  // is a routine signal of attention, not an error.
  const pendingHasBacklog = pendingUploads.count > 0;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Runs in the last 24 hours"
        value={formatNumber(runsLast24Hours.total)}
        subline={
          <DataGeneratedSubline
            bytes={runsLast24Hours.bytesGenerated}
            emptyLabel="No data generated in the last 24 hours"
          />
        }
      />
      <StatCard
        label="Runs in the last 7 days"
        value={formatNumber(runsThisWeek.total)}
        subline={
          <DataGeneratedSubline
            bytes={runsThisWeek.bytesGenerated}
            emptyLabel="No data generated this week"
          />
        }
      />
      <StatCard
        label="Pending uploads"
        value={formatNumber(pendingUploads.count)}
        valueClassName={pendingHasBacklog ? "text-destructive" : undefined}
        subline={
          pendingUploads.count > 0
            ? `${formatBytes(pendingUploads.totalBytes)} queued`
            : "Upload queue is clear"
        }
      />
      <StatCard
        label="My runs this week"
        value={formatNumber(runsThisWeek.mine)}
        subline={
          runsThisWeek.unattributed > 0
            ? `${formatNumber(runsThisWeek.unattributed)} unattributed`
            : "All runs attributed"
        }
      />
    </div>
  );
}
