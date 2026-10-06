import { ShieldOff } from "lucide-react";
import type { Metadata } from "next/types";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { SlackChannelCard } from "@/components/notifications/slack-channel-card";
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
    return (
      <SettingsPageContent>
        <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-background py-16 dark:bg-muted">
          <ShieldOff className="size-10 text-muted-foreground/50" />
          <p className="mt-3 font-medium text-muted-foreground text-sm">
            Admins only
          </p>
          <p className="mt-1 max-w-sm text-center text-muted-foreground/70 text-sm">
            You need workspace admin access to manage integrations. Ask an
            existing admin if you need to be promoted.
          </p>
        </div>
      </SettingsPageContent>
    );
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
