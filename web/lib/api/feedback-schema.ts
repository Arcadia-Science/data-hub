import { z } from "zod";

export const FEEDBACK_TITLE_MAX = 200;
export const FEEDBACK_DESCRIPTION_MAX = 10_000;
export const FEEDBACK_DETAIL_MAX = 2000;
export const FEEDBACK_PAGE_SIZE = 25;
export const FEEDBACK_LIST_MAX = 100;
// List tools shorten the description so an agent does not pull every report
// in full. `get_feedback` returns the complete text.
export const FEEDBACK_LIST_DESCRIPTION_MAX = 280;

export const FEEDBACK_KIND_LABELS = {
  bug: "Bug",
  feature_request: "Feature request",
  other: "Other",
} as const;

export const FEEDBACK_STATUS_LABELS = {
  open: "Open",
  resolved: "Resolved",
  declined: "Declined",
} as const;

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

const feedbackTitleSchema = requiredText(FEEDBACK_TITLE_MAX, "Enter a title");
const feedbackDescriptionSchema = requiredText(
  FEEDBACK_DESCRIPTION_MAX,
  "Enter a description"
);
const feedbackDetailSchema = optionalText(FEEDBACK_DETAIL_MAX);

export const feedbackContentSchema = z.object({
  kind: feedbackKindSchema,
  title: feedbackTitleSchema,
  description: feedbackDescriptionSchema,
  attemptedAction: feedbackDetailSchema,
  toolName: feedbackDetailSchema,
  errorMessage: feedbackDetailSchema,
});

export type FeedbackContent = z.infer<typeof feedbackContentSchema>;
