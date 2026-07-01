// Shared Slack incoming webhook URL validation for the admin settings
// route and client form. Incoming webhooks always live under this host.
export const SLACK_WEBHOOK_URL_PREFIX = "https://hooks.slack.com/services/";

export const SLACK_WEBHOOK_URL_REGEX =
  /^https:\/\/hooks\.slack\.com\/services\/\S+$/;

export function isValidSlackWebhookUrl(url: string): boolean {
  return SLACK_WEBHOOK_URL_REGEX.test(url);
}

export function normalizeSlackWebhookUrlInput(
  v: string | null | undefined
): string | null {
  if (v == null) {
    return null;
  }
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}
