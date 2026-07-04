import { PageHeaderSkeleton } from "@/components/skeletons/page-header-skeleton";
import { TableSkeleton } from "@/components/skeletons/table-skeleton";

export default function InstrumentsLoading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <PageHeaderSkeleton withAction />
      <TableSkeleton
        ariaLabel="Loading instruments"
        headers={[
          "Instrument",
          "Status",
          "File Patterns",
          "Runs This Week",
          "Last Run",
          "Notify",
        ]}
      />
    </div>
  );
}
