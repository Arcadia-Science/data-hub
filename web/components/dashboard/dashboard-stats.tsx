import type { ReactNode } from "react";
import { Card } from "@/components/ui/card";
import type { DashboardStats } from "@/lib/api/dashboard";
import { cn, formatBytes } from "@/lib/utils";

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

export function DashboardStatsCards({ stats }: { stats: DashboardStats }) {
  const { runsLast24Hours, pendingUploads, runsThisWeek } = stats;

  // Highlight pending uploads in red once a backlog forms — a non-zero queue
  // is a routine signal of attention, not an error.
  const pendingHasBacklog = pendingUploads.count > 0;

  return (
    <div className="grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard
        label="Runs in the last 24 hours"
        subline={
          <DataGeneratedSubline
            bytes={runsLast24Hours.bytesGenerated}
            emptyLabel="No data generated in the last 24 hours"
          />
        }
        value={formatNumber(runsLast24Hours.total)}
      />
      <StatCard
        label="Runs in the last 7 days"
        subline={
          <DataGeneratedSubline
            bytes={runsThisWeek.bytesGenerated}
            emptyLabel="No data generated this week"
          />
        }
        value={formatNumber(runsThisWeek.total)}
      />
      <StatCard
        label="Pending uploads"
        subline={
          pendingUploads.count > 0
            ? `${formatBytes(pendingUploads.totalBytes)} queued`
            : "Upload queue is clear"
        }
        value={formatNumber(pendingUploads.count)}
        valueClassName={pendingHasBacklog ? "text-destructive" : undefined}
      />
      <StatCard
        label="My runs this week"
        subline={
          runsThisWeek.unattributed > 0
            ? `${formatNumber(runsThisWeek.unattributed)} unattributed`
            : "All runs attributed"
        }
        value={formatNumber(runsThisWeek.mine)}
      />
    </div>
  );
}
