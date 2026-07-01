import { z } from "zod";

// Shared Slack incoming webhook URL validation for the admin settings
// route and client form. Incoming webhooks always live under this host.
export const SLACK_WEBHOOK_URL_PREFIX = "https://hooks.slack.com/services/";

export const SLACK_WEBHOOK_URL_REGEX =
  /^https:\/\/hooks\.slack\.com\/services\/\S+$/;

export const SLACK_WEBHOOK_URL_MESSAGE =
  "Use a Slack incoming webhook URL (https://hooks.slack.com/services/…).";

/** Non-empty trimmed value that matches Slack's incoming webhook shape. */
export const slackWebhookUrlSchema = z
  .string()
  .trim()
  .min(1, SLACK_WEBHOOK_URL_MESSAGE)
  .refine((url) => SLACK_WEBHOOK_URL_REGEX.test(url), {
    message: SLACK_WEBHOOK_URL_MESSAGE,
  });

export type SlackWebhookUrl = z.infer<typeof slackWebhookUrlSchema>;

export function normalizeSlackWebhookUrlInput(
  v: string | null | undefined
): string | null {
  if (v == null) {
    return null;
  }
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Form field: empty while masked/idle; non-empty must match {@link slackWebhookUrlSchema}. */
export const slackWebhookUrlInputSchema = z
  .string()
  .refine(
    (value) => value.trim().length === 0 || isValidSlackWebhookUrl(value),
    { message: SLACK_WEBHOOK_URL_MESSAGE }
  );

export const slackChannelWebhookFormSchema = z.object({
  webhookUrl: slackWebhookUrlInputSchema,
});

export type SlackChannelWebhookFormValues = z.infer<
  typeof slackChannelWebhookFormSchema
>;

export const slackChannelWebhookPutBodySchema = z.strictObject({
  webhook_url: z
    .string()
    .nullish()
    .transform(normalizeSlackWebhookUrlInput)
    .refine((value) => value === null || isValidSlackWebhookUrl(value), {
      message: SLACK_WEBHOOK_URL_MESSAGE,
    }),
});

export function isValidSlackWebhookUrl(url: string): boolean {
  return slackWebhookUrlSchema.safeParse(url).success;
}
