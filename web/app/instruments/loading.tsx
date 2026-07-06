import { InstrumentsListPageSkeleton } from "@/components/instruments/instruments-table";
import { Skeleton } from "@/components/ui/skeleton";

export default function InstrumentsLoading() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <div className="flex items-center justify-between">
        <h1 className="font-semibold text-2xl tracking-tight">Instruments</h1>
        <Skeleton className="h-8 w-32" />
      </div>
      <InstrumentsListPageSkeleton withRowActions />
    </div>
  );
}
