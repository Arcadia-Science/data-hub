import { z } from "zod";
import {
  feedbackKindSchema,
  feedbackSourceSchema,
  feedbackStatusSchema,
} from "@/lib/api/feedback-schema";

const feedbackPersonSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
});

export const feedbackItemSchema = z.object({
  id: z.string(),
  kind: feedbackKindSchema,
  title: z.string(),
  description: z.string(),
  attemptedAction: z.string().nullable(),
  toolName: z.string().nullable(),
  errorMessage: z.string().nullable(),
  source: feedbackSourceSchema,
  oauthClientId: z.string().nullable(),
  oauthClientName: z.string().nullable(),
  pageUrl: z.string().nullable(),
  status: feedbackStatusSchema,
  adminNote: z.string().nullable(),
  reporter: feedbackPersonSchema.nullable(),
  statusUpdatedBy: feedbackPersonSchema.nullable(),
  statusUpdatedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const sendFeedbackOutputSchema = z.object({
  duplicate: z.boolean(),
  feedback: feedbackItemSchema,
});

export const listFeedbackOutputSchema = z.object({
  feedback: z.array(feedbackItemSchema),
  total: z.number().int(),
});

export const updateFeedbackOutputSchema = z.object({
  feedback: feedbackItemSchema,
});
