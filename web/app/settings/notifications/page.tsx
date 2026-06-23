import type { Metadata } from "next/types";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { NotificationsSettingsForm } from "@/components/notifications/notifications-settings-form";
import { SettingsPageContent } from "@/components/settings/settings-page-content";
import {
  getPreferences,
  listInstrumentSubscriptions,
} from "@/lib/api/notifications";
import { auth } from "@/lib/auth";
import { getSlackConnection } from "@/lib/slack/connections";

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

  // Parallel fetch: the prefs row, per-instrument subscription list, and
  // the Slack connection row are all independent queries.
  const [prefs, subscriptions, slackConn] = await Promise.all([
    getPreferences(session.user.id),
    listInstrumentSubscriptions(session.user.id),
    getSlackConnection(session.user.id),
  ]);

  return (
    <SettingsPageContent>
      <div>
        <h2 className="font-semibold text-lg tracking-tight">Notifications</h2>
        <p className="text-muted-foreground text-sm">
          Choose which Data Hub events to be notified about, and whether to
          receive them in-app, via Slack DM, or both. In-app and Slack are
          independent — for each type you can turn either channel on or off
          without affecting the other.
        </p>
      </div>

      <div className="mt-6">
        {/* Suspense boundary required by useSearchParams inside the form. */}
        <Suspense>
          <NotificationsSettingsForm
            initialInstruments={subscriptions.map((s) => ({
              instrumentId: s.instrumentId,
              displayName: s.displayName,
              enabled: s.enabled,
            }))}
            initialPreferences={{
              runsAllMuted: prefs.runsAllMuted,
              commentsAttributedEnabled: prefs.commentsAttributedEnabled,
              commentsParticipatedEnabled: prefs.commentsParticipatedEnabled,
              slackRunsEnabled: prefs.slackRunsEnabled,
              slackCommentsAttributedEnabled:
                prefs.slackCommentsAttributedEnabled,
              slackCommentsParticipatedEnabled:
                prefs.slackCommentsParticipatedEnabled,
            }}
            slackConnection={
              slackConn
                ? {
                    connected: true,
                    slackTeamName: slackConn.slackTeamName,
                    revoked: slackConn.revokedAt !== null,
                  }
                : { connected: false, slackTeamName: null, revoked: false }
            }
          />
        </Suspense>
      </div>
    </SettingsPageContent>
  );
}
