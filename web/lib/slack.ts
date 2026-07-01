// Posts messages to Slack via the configured incoming webhook URL.
//
// The webhook URL is stored in the `slack_channel_config` singleton row,
// edited via Settings > Notifications by workspace admins. If unset, calls
// become a no-op with a warning so local development and tests don't need a
// webhook configured. Network/HTTP failures are logged but never thrown —
// Slack is a notification side-channel and a Slack outage must not break the
// API request that triggered it.

import { getSlackChannelWebhookUrl } from "@/lib/slack/channel-config";

export async function sendSlackMessage(text: string): Promise<void> {
  const webhookUrl = await getSlackChannelWebhookUrl();
  if (!webhookUrl) {
    console.warn(
      "Slack channel webhook is not configured, skipping Slack message."
    );
    return;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(
        `Slack webhook returned ${response.status}: ${body.slice(0, 200)}`
      );
    }
  } catch (err) {
    console.error("Failed to POST to Slack webhook:", err);
  }
}
