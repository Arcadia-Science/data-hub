// Posts messages to Slack via the configured incoming webhook URL.
//
// Mirrors the contract of the (now-removed) `data_hub_shared.slack` Python
// helper: if `SLACK_WEBHOOK_URL` is unset, calls become a no-op with a
// warning so local development and tests don't need a webhook configured.
// Network/HTTP failures are logged but never thrown — Slack is a notification
// side-channel and a Slack outage must not break the API request that
// triggered it.

export async function sendSlackMessage(text: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn("SLACK_WEBHOOK_URL is not set, skipping Slack message.");
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
