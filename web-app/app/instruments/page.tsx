import { SignInRequired } from "@/components/auth/sign-in-required";
import {
  InstrumentRowManagementActions,
  InstrumentsTable,
} from "@/components/instruments/instruments-table";
import { getInstrumentListWithCounts } from "@/lib/api/instruments";
import { auth } from "@/lib/auth";
import type { Metadata } from "next/types";

const description = "Instruments connected to Data Hub.";

export const metadata: Metadata = {
  title: "Instruments",
  description,
  openGraph: { title: "Instruments", description },
  twitter: { title: "Instruments", description },
};

export default async function InstrumentsPage() {
  const session = await auth();
  if (!session) {
    return (
      <SignInRequired callbackUrl="/instruments">
        Sign in to browse instruments.
      </SignInRequired>
    );
  }

  const instruments = await getInstrumentListWithCounts();

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
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
