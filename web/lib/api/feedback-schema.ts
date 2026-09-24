import { z } from "zod";

export const FEEDBACK_TITLE_MAX = 200;
export const FEEDBACK_DESCRIPTION_MAX = 10_000;
export const FEEDBACK_DETAIL_MAX = 2000;
export const FEEDBACK_PAGE_SIZE = 25;
export const FEEDBACK_LIST_MAX = 100;

export const feedbackKindSchema = z.enum(["bug", "feature_request", "other"]);
export const feedbackStatusSchema = z.enum(["open", "resolved", "declined"]);
export const feedbackSourceSchema = z.enum(["mcp", "web"]);

export type FeedbackKind = z.infer<typeof feedbackKindSchema>;
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;
export type FeedbackSource = z.infer<typeof feedbackSourceSchema>;

function requiredText(max: number, emptyMessage: string) {
  return z
    .string()
    .trim()
    .min(1, emptyMessage)
    .max(max, `Use ${max.toLocaleString("en-US")} characters or fewer`);
}

// Blank optional fields become absent so the row stores NULL, not "".
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max, `Use ${max.toLocaleString("en-US")} characters or fewer`)
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined));
}

export const feedbackContentSchema = z.object({
  kind: feedbackKindSchema,
  title: requiredText(FEEDBACK_TITLE_MAX, "Enter a title"),
  description: requiredText(FEEDBACK_DESCRIPTION_MAX, "Enter a description"),
  attemptedAction: optionalText(FEEDBACK_DETAIL_MAX),
  toolName: optionalText(FEEDBACK_DETAIL_MAX),
  errorMessage: optionalText(FEEDBACK_DETAIL_MAX),
});

export type FeedbackContent = z.infer<typeof feedbackContentSchema>;

export const updateFeedbackSchema = z.object({
  status: feedbackStatusSchema,
  note: optionalText(FEEDBACK_DETAIL_MAX),
});
