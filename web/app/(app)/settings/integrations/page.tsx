import type { Metadata } from "next/types";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { LinearCard } from "@/components/integrations/linear-card";
import { SlackAppCard } from "@/components/integrations/slack-app-card";
import { SlackChannelCard } from "@/components/notifications/slack-channel-card";
import { AdminsOnly } from "@/components/settings/admins-only";
import { SettingsPageContent } from "@/components/settings/settings-page-content";
import { appOrigin } from "@/lib/app-origin";
import { auth } from "@/lib/auth";
import { getLinearConfigForAdmin } from "@/lib/linear/config";
import { getSlackAppConfigForAdmin } from "@/lib/slack/app-config";
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

  const [linear, slackApp, slackChannel] = await Promise.all([
    getLinearConfigForAdmin(),
    getSlackAppConfigForAdmin(),
    getSlackChannelConfigForAdmin(),
  ]);

  return (
    <SettingsPageContent>
      <div>
        <h2 className="text-pretty font-semibold text-lg tracking-tight">
          Integrations
        </h2>
        <p className="text-muted-foreground text-sm">
          Connections used by the whole workspace. Personal notification choices
          stay under Notifications. Linear receives feedback reports once a team
          is saved.
        </p>
      </div>
      <div className="mt-6 flex flex-col gap-6">
        <LinearCard
          clientId={linear.clientId}
          clientSecret={linear.clientSecret}
          key={linear.lastUpdated?.at ?? "never-saved"}
          labels={linear.labels}
          lastWebhookAt={linear.lastWebhookAt?.toISOString() ?? null}
          project={linear.project}
          team={linear.team}
          webhookSecret={linear.webhookSecret}
          webhookUrl={`${appOrigin()}/api/v1/integrations/linear/webhook`}
        />
        <SlackAppCard
          botToken={slackApp.botToken}
          clientId={slackApp.clientId}
          clientSecret={slackApp.clientSecret}
          key={slackApp.lastUpdated?.at ?? "never-saved"}
          teamId={slackApp.teamId}
        />
        <SlackChannelCard.SectionHeader configured={slackChannel.configured} />
        <SlackChannelCard.Form
          configured={slackChannel.configured}
          lastUpdated={slackChannel.lastUpdated}
        />
      </div>
    </SettingsPageContent>
  );
}
