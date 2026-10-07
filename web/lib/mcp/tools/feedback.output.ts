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
  reporter: feedbackPersonSchema.nullable(),
  statusUpdatedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  linearIssue: z.object({
    identifier: z.string(),
    url: z.string(),
    stateName: z.string(),
    stateType: z.string(),
    stateColor: z.string(),
    priority: z.number().nullable(),
    priorityLabel: z.string().nullable(),
    labels: z.array(z.object({ name: z.string(), color: z.string() })),
    assignee: z
      .object({
        name: z.string(),
        email: z.string().nullable(),
        avatarUrl: z.string().nullable(),
        userId: z.string(),
      })
      .nullable(),
    projectName: z.string().nullable(),
    teamName: z.string(),
  }),
  activity: z
    .array(
      z.object({
        kind: z.enum(["comment", "status"]),
        at: z.string(),
        actorName: z.string().nullable(),
        fromState: z.string().nullable(),
        toState: z.string().nullable(),
        body: z.string().nullable(),
      })
    )
    .nullable(),
});

export const sendFeedbackOutputSchema = z.object({
  duplicate: z.boolean(),
  feedback: feedbackItemSchema,
});

export const listFeedbackOutputSchema = z.object({
  feedback: z.array(feedbackItemSchema),
  total: z.number().int(),
  counts: z.object({
    open: z.number().int(),
    closed: z.number().int(),
    resolved: z.number().int(),
    declined: z.number().int(),
  }),
  groups: z.array(
    z.object({
      stateId: z.string(),
      name: z.string(),
      color: z.string(),
      type: z.string(),
      count: z.number().int(),
    })
  ),
});
