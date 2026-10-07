import type { Metadata } from "next/types";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { SlackChannelCard } from "@/components/notifications/slack-channel-card";
import { AdminsOnly } from "@/components/settings/admins-only";
import { SettingsPageContent } from "@/components/settings/settings-page-content";
import { auth } from "@/lib/auth";
import { getSlackChannelConfigForAdmin } from "@/lib/slack/channel-config";

const description =
  "Connect Data Hub to Slack and other services used by the whole workspace.";

export const metadata: Metadata = {
  title: "Integrations",
  description,
  openGraph: { title: "Integrations", description },
  twitter: { title: "Integrations", description },
};

export default async function IntegrationsSettingsPage() {
  const session = await auth();
  if (!session?.user) {
    return (
      <SignInRequired callbackUrl="/settings/integrations">
        Sign in to manage integrations.
      </SignInRequired>
    );
  }

  if (!session.user.isAdmin) {
    return <AdminsOnly>manage integrations</AdminsOnly>;
  }

  const slackChannel = await getSlackChannelConfigForAdmin();

  return (
    <SettingsPageContent>
      <div>
        <h2 className="text-pretty font-semibold text-lg tracking-tight">
          Integrations
        </h2>
        <p className="text-muted-foreground text-sm">
          Connections used by the whole workspace. Personal notification choices
          stay under Notifications.
        </p>
      </div>
      <div className="mt-6 flex flex-col gap-6">
        <SlackChannelCard.SectionHeader configured={slackChannel.configured} />
        <SlackChannelCard.Form
          configured={slackChannel.configured}
          lastUpdated={
            slackChannel.updatedAt
              ? {
                  at: slackChannel.updatedAt.toISOString(),
                  byName: slackChannel.updatedByName,
                  byEmail: slackChannel.updatedByEmail,
                }
              : null
          }
        />
      </div>
    </SettingsPageContent>
  );
}
