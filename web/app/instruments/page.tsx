import type { Metadata } from "next/types";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { AddInstrumentDialog } from "@/components/instruments/add-instrument-dialog";
import {
  InstrumentsView,
  InstrumentsViewSkeleton,
} from "@/components/instruments/instruments-view";
import { getInstrumentListWithCounts } from "@/lib/api/instruments";
import {
  getPreferences,
  listInstrumentSubscriptions,
} from "@/lib/api/notifications";
import { auth } from "@/lib/auth";
import { ADD_INSTRUMENT_DOCS_URL, MANAGING_TOKENS_DOCS_URL } from "@/lib/docs";

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

  // Row actions (Edit / Retire / Reactivate + the pending Confirm button) are
  // admin-only; regular members see the same listing without them. The tabs
  // themselves are visible to everyone.
  const isAdmin = session.user.isAdmin === true;

  // Header renders immediately; the tabs stream so a slow catalogue query
  // doesn't hold up the "Add instrument" affordance.
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6 2xl:w-7xl">
      <div className="flex items-center justify-between">
        <h1 className="font-semibold text-2xl tracking-tight">Instruments</h1>
        <AddInstrumentDialog
          getTokenUrl={MANAGING_TOKENS_DOCS_URL}
          setupGuideUrl={ADD_INSTRUMENT_DOCS_URL}
        />
      </div>
      <Suspense fallback={<InstrumentsViewSkeleton withRowActions={isAdmin} />}>
        <InstrumentsListSection isAdmin={isAdmin} userId={session.user.id} />
      </Suspense>
    </div>
  );
}

async function InstrumentsListSection({
  isAdmin,
  userId,
}: {
  isAdmin: boolean;
  userId: string;
}) {
  // All three queries are independent; running them together avoids the
  // ladder of waterfalls a serial fetch would incur. The subscription
  // helper returns the full instrument catalogue with each row's
  // current `enabled` state, which we collapse into a Map for O(1)
  // lookup inside the table.
  const [instruments, subscriptions, prefs] = await Promise.all([
    getInstrumentListWithCounts(),
    listInstrumentSubscriptions(userId),
    getPreferences(userId),
  ]);

  const subscriptionMap = new Map(
    subscriptions.map((s) => [s.instrumentId, s.enabled])
  );

  // Partition by lifecycle status for the tabs. The catalogue is small, so a
  // single query + client-side split is cheaper than three status-filtered
  // queries (mirrors the watchers page).
  const activeData = instruments.filter((i) => i.status === "active");
  const pendingData = instruments.filter((i) => i.status === "pending");
  const retiredData = instruments.filter((i) => i.status === "inactive");

  return (
    <InstrumentsView
      activeData={activeData}
      isAdmin={isAdmin}
      notifications={{
        subscriptions: subscriptionMap,
        masterMuted: prefs.runsAllMuted,
      }}
      pendingData={pendingData}
      retiredData={retiredData}
    />
  );
}
