import { after } from "next/server";
import type { Metadata } from "next/types";
import { SignInRequired } from "@/components/auth/sign-in-required";
import { LinearSetup } from "@/components/integrations/linear/linear-setup";
import type { LinearSetupData } from "@/components/integrations/linear/linear-setup-context";
import { SlackAppCard } from "@/components/integrations/slack-app-card";
import {
  SlackChannelForm,
  SlackChannelSectionHeader,
} from "@/components/notifications/slack-channel-card";
import { AdminsOnly } from "@/components/settings/admins-only";
import { SettingsPageContent } from "@/components/settings/settings-page-content";
import { appOrigin } from "@/lib/app-origin";
import { auth } from "@/lib/auth";
import {
  type IntegrationSecretsKeyStatus,
  integrationSecretsKeyStatus,
} from "@/lib/crypto/integration-secrets";
import {
  backfillLinearSetup,
  getLinearConfigForAdmin,
  type LinearConfigForAdmin,
} from "@/lib/linear/config";
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

  // Runs after the page is sent, so a slow or unreachable Linear never holds
  // up or breaks the page. The values it saves show on the next load.
  after(backfillLinearSetup);
  const [linear, slackApp, slackChannel] = await Promise.all([
    getLinearConfigForAdmin(),
    getSlackAppConfigForAdmin(),
    getSlackChannelConfigForAdmin(),
  ]);
  const keyStatus = integrationSecretsKeyStatus();
  const origin = appOrigin();

  return (
    <SettingsPageContent>
      <div>
        <h2 className="text-pretty font-semibold text-lg tracking-tight">
          Integrations
        </h2>
        <p className="text-muted-foreground text-sm">{description}</p>
      </div>
      <div className="mt-6 flex flex-col gap-6">
        {/* Each key has its own prefix. Two siblings with the same key make React
            keep the old one on screen when one of them remounts. */}
        <LinearSetup
          initial={linearSetupData(linear, keyStatus, origin)}
          key={`linear-${linear.lastUpdated?.at ?? "never-saved"}`}
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

function linearSetupData(
  config: LinearConfigForAdmin,
  keyStatus: IntegrationSecretsKeyStatus,
  origin: string
): LinearSetupData {
  return {
    clientId: config.clientId.value,
    clientSecretSet: config.clientSecret.set,
    keyStatus,
    labels: config.labels,
    lastUpdatedAt: config.lastUpdated?.at ?? null,
    lastUpdatedBy: config.lastUpdated?.byName ?? null,
    lastWebhookAt: config.lastWebhookAt?.toISOString() ?? null,
    origin,
    project: config.project,
    rejectionReason: config.lastWebhookRejectionReason,
    team: config.team
      ? { ...config.team, key: config.teamKey ?? undefined }
      : null,
    webhookRejections: config.webhookRejections,
    webhookSecretSet: config.webhookSecret.set,
    webhookUrl: `${origin}/api/v1/integrations/linear/webhook`,
    workspaceName: config.workspaceName,
  };
}
