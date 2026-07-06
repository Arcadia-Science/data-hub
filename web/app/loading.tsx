import { StatCardsSkeleton } from "@/components/dashboard/dashboard-stats";
import { DashboardRunsSkeleton } from "@/components/dashboard/runs-table";
import { InstrumentsTableSkeleton } from "@/components/instruments/instruments-table";

export default function DashboardLoading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 p-6 2xl:w-7xl">
      <StatCardsSkeleton />

      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-lg tracking-tight">Instruments</h2>
        <InstrumentsTableSkeleton
          footerLabel="View all instruments"
          rows={3}
          withFooter
          withNotifications={false}
        />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-lg tracking-tight">Recent runs</h2>
        <DashboardRunsSkeleton />
      </section>
    </div>
  );
}
