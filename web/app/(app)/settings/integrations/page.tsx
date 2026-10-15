import { LinearSetupSection } from "@arcadiascience/app-feedback-toolkit/next";
import type { Metadata } from "next/types";
import { Suspense } from "react";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { SlackAppCard } from "@/components/integrations/slack-app-card";
import {
  SlackChannelForm,
  SlackChannelSectionHeader,
} from "@/components/notifications/slack-channel-card";
import { AdminsOnly } from "@/components/settings/admins-only";
import { SettingsPageContent } from "@/components/settings/settings-page-content";
import { Skeleton } from "@/components/ui/skeleton";
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

  // The header paints now. The cards wait for the saved Slack settings.
  return (
    <SettingsPageContent>
      <div>
        <h1 className="text-pretty font-semibold text-lg tracking-tight">
          Integrations
        </h1>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      <div className="mt-6 flex flex-col gap-6">
        <Suspense fallback={<IntegrationsSkeleton />}>
          <IntegrationCards />
        </Suspense>
      </div>
    </SettingsPageContent>
  );
}

async function IntegrationCards() {
  const [slackApp, slackChannel] = await Promise.all([
    getSlackAppConfigForAdmin(),
    getSlackChannelConfigForAdmin(),
  ]);
  const keyStatus = integrationSecretsKeyStatus();

  return (
    <>
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
    </>
  );
}

function IntegrationsSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading integrations" role="status">
      <div className="flex flex-col gap-6">
        <Skeleton className="h-48 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-lg" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    </div>
  );
}
