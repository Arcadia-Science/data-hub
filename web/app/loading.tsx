import { RunsTableSkeleton } from "@/components/dashboard/runs-table";
import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { StatCardsSkeleton } from "@/components/skeletons/stat-cards-skeleton";
import { TableSkeleton } from "@/components/skeletons/table-skeleton";

export default function DashboardLoading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 p-6 2xl:w-7xl">
      <StatCardsSkeleton />

      <section className="flex flex-col gap-3">
        <PageHeaderSkeleton />
        <TableSkeleton
          ariaLabel="Loading instruments"
          headers={[
            "Instrument",
            "Status",
            "File Patterns",
            "Runs This Week",
            "Last Run",
          ]}
          rows={3}
        />
      </section>

      <section className="flex flex-col gap-3">
        <PageHeaderSkeleton />
        <RunsTableSkeleton />
      </section>
    </div>
  );
}
