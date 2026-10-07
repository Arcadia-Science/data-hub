// The JSON body the Linear settings routes return. It lives here, not in a
// route file, so the connect route and the page share one shape.

import {
  type IntegrationSecretsKeyStatus,
  integrationSecretsKeyStatus,
} from "@/lib/crypto/integration-secrets";
import { lastUpdatedResponse } from "@/lib/integrations/last-updated";
import type { LinearConfigForAdmin } from "./config";

export function linearConfigResponse(
  config: LinearConfigForAdmin,
  keyStatus: IntegrationSecretsKeyStatus = integrationSecretsKeyStatus()
) {
  return {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    webhook_secret: config.webhookSecret,
    team: config.team,
    team_key: config.teamKey,
    project: config.project,
    project_url: config.projectUrl,
    labels: config.labels,
    workspace_id: config.workspaceId,
    workspace_name: config.workspaceName,
    workspace_url_key: config.workspaceUrlKey,
    webhook_rejections: config.webhookRejections,
    last_webhook_rejected_at: config.lastWebhookRejectedAt
      ? config.lastWebhookRejectedAt.toISOString()
      : null,
    last_webhook_rejection_reason: config.lastWebhookRejectionReason,
    last_webhook_at: config.lastWebhookAt
      ? config.lastWebhookAt.toISOString()
      : null,
    secrets_key: keyStatus,
    ...lastUpdatedResponse(config.lastUpdated),
  };
}
