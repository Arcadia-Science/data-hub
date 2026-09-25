import { z } from "zod";
import {
  FEEDBACK_DESCRIPTION_MAX,
  FEEDBACK_DETAIL_MAX,
  FEEDBACK_TITLE_MAX,
  feedbackKindSchema,
  feedbackSourceSchema,
  feedbackStatusSchema,
} from "@/lib/api/feedback-schema";
import { isoDateTime } from "./common";

function requiredText(max: number) {
  return z.string().trim().min(1).max(max);
}

function optionalText(max: number) {
  return z.string().trim().max(max).optional();
}

export const listFeedbackQuery = z.object({
  status: feedbackStatusSchema.optional(),
  kind: feedbackKindSchema.optional(),
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce.number().int().min(1).max(100).optional(),
});

export const createFeedbackBody = z
  .object({
    kind: feedbackKindSchema,
    title: requiredText(FEEDBACK_TITLE_MAX),
    description: requiredText(FEEDBACK_DESCRIPTION_MAX),
    attempted_action: optionalText(FEEDBACK_DETAIL_MAX),
    tool_name: optionalText(FEEDBACK_DETAIL_MAX),
    error_message: optionalText(FEEDBACK_DETAIL_MAX),
    page_url: optionalText(FEEDBACK_DETAIL_MAX),
  })
  .openapi("CreateFeedbackBody");

export const updateFeedbackBody = z
  .object({
    status: feedbackStatusSchema,
    note: optionalText(FEEDBACK_DETAIL_MAX),
  })
  .openapi("UpdateFeedbackBody");

const feedbackPerson = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
});

export const feedbackDetail = z
  .object({
    id: z.string().uuid(),
    kind: feedbackKindSchema,
    title: z.string(),
    description: z.string(),
    attempted_action: z.string().nullable(),
    tool_name: z.string().nullable(),
    error_message: z.string().nullable(),
    source: feedbackSourceSchema,
    oauth_client_id: z.string().nullable(),
    oauth_client_name: z.string().nullable(),
    page_url: z.string().nullable(),
    status: feedbackStatusSchema,
    admin_note: z.string().nullable(),
    reporter: feedbackPerson.nullable(),
    status_updated_by: feedbackPerson.nullable(),
    status_updated_at: isoDateTime.nullable(),
    created_at: isoDateTime,
    updated_at: isoDateTime,
  })
  .openapi("Feedback");

export const feedbackCreated = z
  .object({
    duplicate: z.boolean(),
    feedback: feedbackDetail,
  })
  .openapi("FeedbackCreated");

export const feedbackList = z
  .object({
    feedback: z.array(feedbackDetail),
    total: z.number().int(),
    counts: z.object({
      open: z.number().int(),
      resolved: z.number().int(),
      declined: z.number().int(),
    }),
  })
  .openapi("FeedbackList");
