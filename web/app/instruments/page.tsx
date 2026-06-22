import type { Metadata } from "next/types";
import { SignInRequired } from "@/components/auth/sign-in-required";
import {
  InstrumentRowManagementActions,
  InstrumentsTable,
} from "@/components/instruments/instruments-table";
import { getInstrumentListWithCounts } from "@/lib/api/instruments";
import {
  getPreferences,
  listInstrumentSubscriptions,
} from "@/lib/api/notifications";
import { auth } from "@/lib/auth";

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

  // All four queries are independent; running them together avoids the
  // ladder of waterfalls a serial fetch would incur. The subscription
  // helper returns the full instrument catalogue with each row's
  // current `enabled` state, which we collapse into a Map for O(1)
  // lookup inside the table.
  const [instruments, subscriptions, prefs] = await Promise.all([
    getInstrumentListWithCounts(),
    listInstrumentSubscriptions(session.user.id),
    getPreferences(session.user.id),
  ]);

  // Composition: the management actions cell (Edit dialog + Confirm
  // pending button) is rendered only for admins. Regular members see the
  // same listing without the trailing actions column. InstrumentsTable
  // already supports `renderRowActions` being omitted entirely, so no
  // table-level prop changes are needed.
  const isAdmin = session.user.isAdmin === true;

  const subscriptionMap = new Map(
    subscriptions.map((s) => [s.instrumentId, s.enabled])
  );

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <div className="flex items-center justify-between">
        <h1 className="font-semibold text-2xl tracking-tight">Instruments</h1>
      </div>
      <InstrumentsTable
        data={instruments}
        notifications={{
          subscriptions: subscriptionMap,
          masterMuted: prefs.runsAllMuted,
        }}
        renderRowActions={isAdmin ? InstrumentRowManagementActions : undefined}
      />
    </div>
  );
}
