import { InstrumentHeaderSkeleton } from "@/components/instruments/instrument-header";
import { InstrumentRunsSkeleton } from "@/components/instruments/runs-table/instrument-runs-skeleton";

export default function InstrumentDetailLoading() {
  return (
    <div className="mx-auto flex w-full min-w-0 max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <InstrumentHeaderSkeleton />
      <InstrumentRunsSkeleton />
    </div>
  );
}
