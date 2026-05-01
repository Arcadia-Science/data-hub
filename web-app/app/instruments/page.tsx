import {
  InstrumentRowManagementActions,
  InstrumentsTable,
} from "@/components/instruments/instruments-table";
import { getInstrumentListWithCounts } from "@/lib/api/instruments";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import type { Metadata } from "next/types";

export const metadata: Metadata = {
  title: "Instruments",
};

export default async function InstrumentsPage() {
  const session = await auth();
  if (!session) redirect("/login");

  const instruments = await getInstrumentListWithCounts();

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Instruments</h1>
      </div>
      <InstrumentsTable
        data={instruments}
        renderRowActions={InstrumentRowManagementActions}
      />
    </div>
  );
}
