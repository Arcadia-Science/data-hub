import type { Metadata } from "next/types";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { NotificationsSettingsForm } from "@/components/notifications/notifications-settings-form";
import { NotificationsSettingsFormSkeleton } from "@/components/notifications/notifications-settings-skeleton";
import { SettingsPageContent } from "@/components/settings/settings-page-content";
import {
  getPreferences,
  listInstrumentSubscriptions,
} from "@/lib/api/notifications";
import { auth } from "@/lib/auth";
import { getSlackChannelConfigForAdmin } from "@/lib/slack/channel-config";
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

  const isAdmin = session.user.isAdmin === true;

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
        {/*
          One boundary does double duty: it streams the settings data (so the
          header paints first) and satisfies the `useSearchParams` requirement
          inside the client form.
        */}
        <Suspense
          fallback={<NotificationsSettingsFormSkeleton isAdmin={isAdmin} />}
        >
          <NotificationsFormSection
            isAdmin={isAdmin}
            userId={session.user.id}
          />
        </Suspense>
      </div>
    </SettingsPageContent>
  );
}

async function NotificationsFormSection({
  isAdmin,
  userId,
}: {
  isAdmin: boolean;
  userId: string;
}) {
  // Parallel fetch: the prefs row, per-instrument subscription list, Slack
  // connection, and (for admins) channel webhook metadata are independent.
  const [prefs, subscriptions, slackConn, slackChannelConfig] =
    await Promise.all([
      getPreferences(userId),
      listInstrumentSubscriptions(userId),
      getSlackConnection(userId),
      isAdmin ? getSlackChannelConfigForAdmin() : Promise.resolve(null),
    ]);

  return (
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
        slackCommentsAttributedEnabled: prefs.slackCommentsAttributedEnabled,
        slackCommentsParticipatedEnabled:
          prefs.slackCommentsParticipatedEnabled,
      }}
      slackChannelConfig={
        slackChannelConfig
          ? {
              configured: slackChannelConfig.configured,
              lastUpdated: slackChannelConfig.updatedAt
                ? {
                    at: slackChannelConfig.updatedAt.toISOString(),
                    byName: slackChannelConfig.updatedByName,
                    byEmail: slackChannelConfig.updatedByEmail,
                  }
                : null,
            }
          : null
      }
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
  );
}
