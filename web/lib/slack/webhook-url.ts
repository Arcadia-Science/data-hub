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
  .url({ message: "Enter a valid HTTPS URL." })
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
  .superRefine((value, ctx) => {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return;
    }
    const result = slackWebhookUrlSchema.safeParse(trimmed);
    if (!result.success) {
      ctx.addIssue({
        code: "custom",
        message: result.error.issues[0]?.message ?? SLACK_WEBHOOK_URL_MESSAGE,
      });
    }
  });

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
    .superRefine((value, ctx) => {
      if (value === null) {
        return;
      }
      const result = slackWebhookUrlSchema.safeParse(value);
      if (!result.success) {
        ctx.addIssue({
          code: "custom",
          message: result.error.issues[0]?.message ?? SLACK_WEBHOOK_URL_MESSAGE,
        });
      }
    }),
});

export function isValidSlackWebhookUrl(url: string): boolean {
  return slackWebhookUrlSchema.safeParse(url).success;
}
