import { SignInRequired } from "@/components/auth/sign-in-required";
import { NotificationsSettingsForm } from "@/components/notifications/notifications-settings-form";
import {
  getPreferences,
  listInstrumentSubscriptions,
} from "@/lib/api/notifications";
import { auth } from "@/lib/auth";
import type { Metadata } from "next/types";

const description = "Choose which Data Hub events to be notified about.";

export const metadata: Metadata = {
  title: "Notifications",
  description,
  openGraph: { title: "Notifications", description },
  twitter: { title: "Notifications", description },
};

export default async function NotificationsSettingsPage() {
  const session = await auth();
  if (!session?.user) {
    return (
      <SignInRequired callbackUrl="/settings/notifications">
        Sign in to manage notification settings.
      </SignInRequired>
    );
  }

  // Parallel fetch: the prefs row and the per-instrument subscription
  // list are independent queries. `getPreferences` falls back to
  // schema-side defaults when no row exists yet, so the form always
  // renders with concrete values — no need for nullable form state.
  const [prefs, subscriptions] = await Promise.all([
    getPreferences(session.user.id!),
    listInstrumentSubscriptions(session.user.id!),
  ]);

  return (
    <div>
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Notifications</h2>
        <p className="text-sm text-muted-foreground">
          Choose which Data Hub events should produce an in-app notification.
          Per-instrument subscriptions opt you in to <em>new run</em>{" "}
          notifications; comment notifications fire when someone replies on a
          run you&apos;re attributed to or have commented on.
        </p>
      </div>

      <div className="mt-6">
        <NotificationsSettingsForm
          initialPreferences={{
            runsAllMuted: prefs.runsAllMuted,
            commentsAttributedEnabled: prefs.commentsAttributedEnabled,
            commentsParticipatedEnabled: prefs.commentsParticipatedEnabled,
          }}
          initialInstruments={subscriptions.map((s) => ({
            instrumentId: s.instrumentId,
            displayName: s.displayName,
            enabled: s.enabled,
          }))}
        />
      </div>
    </div>
  );
}
