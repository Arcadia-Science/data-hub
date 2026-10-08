import { LinearSetupSection } from "@arcadiascience/app-feedback-toolkit/next";
import type { Metadata } from "next/types";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { SlackAppCard } from "@/components/integrations/slack-app-card";
import {
  SlackChannelForm,
  SlackChannelSectionHeader,
} from "@/components/notifications/slack-channel-card";
import { AdminsOnly } from "@/components/settings/admins-only";
import { SettingsPageContent } from "@/components/settings/settings-page-content";
import { auth } from "@/lib/auth";
import { integrationSecretsKeyStatus } from "@/lib/crypto/integration-secrets";
import { feedback } from "@/lib/feedback";
import { getSlackAppConfigForAdmin } from "@/lib/slack/app-config";
import { getSlackChannelConfigForAdmin } from "@/lib/slack/channel-config";

const description =
  "Services connected for everyone in Data Hub. Your own notification choices are under Notifications.";

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

  const [slackApp, slackChannel] = await Promise.all([
    getSlackAppConfigForAdmin(),
    getSlackChannelConfigForAdmin(),
  ]);
  const keyStatus = integrationSecretsKeyStatus();

  return (
    <SettingsPageContent>
      <div>
        <h2 className="text-pretty font-semibold text-lg tracking-tight">
          Integrations
        </h2>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      <div className="mt-6 flex flex-col gap-6">
        <LinearSetupSection
          feedback={feedback}
          webhookPath="/api/v1/integrations/linear/webhook"
        />
        <SlackAppCard
          botToken={slackApp.botToken}
          clientId={slackApp.clientId}
          clientSecret={slackApp.clientSecret}
          key={`slack-app-${slackApp.lastUpdated?.at ?? "never-saved"}`}
          secretsKeyOk={keyStatus === "ok"}
          teamId={slackApp.teamId}
        />
        <SlackChannelSectionHeader configured={slackChannel.configured} />
        <SlackChannelForm
          configured={slackChannel.configured}
          lastUpdated={slackChannel.lastUpdated}
        />
      </div>
    </SettingsPageContent>
  );
}
