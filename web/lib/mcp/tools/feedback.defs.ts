import { z } from "zod";
import {
  FEEDBACK_DESCRIPTION_MAX,
  FEEDBACK_DETAIL_MAX,
  FEEDBACK_LIST_DESCRIPTION_MAX,
  FEEDBACK_LIST_MAX,
  FEEDBACK_TITLE_MAX,
  feedbackKindSchema,
  feedbackListStatusSchema,
} from "@/lib/api/feedback-schema";
import type { McpToolDef } from "@/lib/mcp/catalog/types";
import {
  feedbackItemSchema,
  listFeedbackOutputSchema,
  sendFeedbackOutputSchema,
} from "./feedback.output";

export const sendFeedbackTool = {
  name: "send_feedback",
  title: "Send Feedback",
  description:
    "Report a bug or request about Data Hub itself (the web app, MCP tools, or the watcher). Show the user this draft and get their approval before calling. For a problem with a specific run's data, use add_run_comment instead. Any read token can call this.",
  group: "feedback",
  inputSchema: {
    kind: feedbackKindSchema.describe("Type: bug, feature_request, or other"),
    title: z
      .string()
      .trim()
      .min(1)
      .max(FEEDBACK_TITLE_MAX)
      .describe("One-line summary"),
    description: z
      .string()
      .trim()
      .min(1)
      .max(FEEDBACK_DESCRIPTION_MAX)
      .describe("What happened or what you want"),
    attemptedAction: z
      .string()
      .trim()
      .max(FEEDBACK_DETAIL_MAX)
      .optional()
      .describe("Trying to do, if known"),
    toolName: z
      .string()
      .trim()
      .max(FEEDBACK_DETAIL_MAX)
      .optional()
      .describe("Tool, if any"),
    errorMessage: z
      .string()
      .trim()
      .max(FEEDBACK_DETAIL_MAX)
      .optional()
      .describe("Error message, if any"),
  },
  outputSchema: sendFeedbackOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
} as const satisfies McpToolDef;

export const listFeedbackTool = {
  name: "list_feedback",
  title: "List Feedback",
  description: `List feedback reports. Workspace admins see every report, including priority and assignee; everyone else sees only their own, without those. Descriptions longer than ${FEEDBACK_LIST_DESCRIPTION_MAX} characters are shortened. Use get_feedback for the full report and its activity.`,
  group: "feedback",
  inputSchema: {
    status: feedbackListStatusSchema
      .optional()
      .describe(
        "Filter by open, closed, resolved, or declined. closed is resolved and declined together. Results follow Linear's status order, then newest first."
      ),
    kind: feedbackKindSchema
      .optional()
      .describe("Filter by bug, feature_request, or other"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(FEEDBACK_LIST_MAX)
      .optional()
      .describe(`Page size (default 25, max ${FEEDBACK_LIST_MAX})`),
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Page number (default 1)"),
  },
  outputSchema: listFeedbackOutputSchema,
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const getFeedbackTool = {
  name: "get_feedback",
  title: "Get Feedback",
  description:
    "Get one feedback report, including the full description. Admins also get priority, assignee, and the activity list. Pass the report id or the Linear issue ID, such as ENG-1476. Workspace admins can read any report; everyone else can read only their own.",
  group: "feedback",
  inputSchema: {
    id: z
      .string()
      .trim()
      .min(1)
      .describe("Feedback report id or Linear issue ID, such as ENG-1476"),
  },
  outputSchema: z.object({ feedback: feedbackItemSchema }),
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const FEEDBACK_TOOL_DEFS = [
  sendFeedbackTool,
  listFeedbackTool,
  getFeedbackTool,
] as const;
