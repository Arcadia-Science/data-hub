import { z } from "zod";
import {
  FEEDBACK_DESCRIPTION_MAX,
  FEEDBACK_DETAIL_MAX,
  FEEDBACK_LIST_DESCRIPTION_MAX,
  FEEDBACK_LIST_MAX,
  FEEDBACK_TITLE_MAX,
  feedbackKindSchema,
  feedbackStatusSchema,
} from "@/lib/api/feedback-schema";
import type { McpToolDef } from "@/lib/mcp/catalog/types";
import {
  feedbackItemSchema,
  listFeedbackOutputSchema,
  sendFeedbackOutputSchema,
  updateFeedbackOutputSchema,
} from "./feedback.output";

export const sendFeedbackTool = {
  name: "send_feedback",
  title: "Send Feedback",
  description:
    "Report a bug or request about Data Hub itself (the web app, MCP tools, or the watcher). Show the user this draft and get their approval before calling. For a problem with a specific run's data, use add_run_comment instead. Any read token can call this.",
  group: "feedback",
  inputSchema: {
    kind: feedbackKindSchema.describe("bug, feature_request, or other"),
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
      .describe("What the user was trying to do"),
    toolName: z
      .string()
      .trim()
      .max(FEEDBACK_DETAIL_MAX)
      .optional()
      .describe("MCP tool involved, if any"),
    errorMessage: z
      .string()
      .trim()
      .max(FEEDBACK_DETAIL_MAX)
      .optional()
      .describe("Error text, if any"),
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
  description: `List feedback reports. Workspace admins see every report; everyone else sees only their own. Descriptions longer than ${FEEDBACK_LIST_DESCRIPTION_MAX} characters are shortened. Use get_feedback for the full report.`,
  group: "feedback",
  inputSchema: {
    status: feedbackStatusSchema
      .optional()
      .describe("Filter by open, resolved, or declined"),
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

export const updateFeedbackTool = {
  name: "update_feedback",
  title: "Update Feedback",
  description:
    "Set a feedback report's status to open, resolved, or declined, with an optional note shown to the reporter. Workspace admin only, and requires the write scope. Changing the status to resolved or declined notifies the reporter. Editing only the note does not.",
  group: "feedback",
  inputSchema: {
    id: z.string().uuid().describe("Feedback report id"),
    status: feedbackStatusSchema.describe("open, resolved, or declined"),
    note: z
      .string()
      .trim()
      .max(FEEDBACK_DETAIL_MAX)
      .optional()
      .describe(
        "Note shown to the reporter. Pass an empty string to clear it."
      ),
  },
  outputSchema: updateFeedbackOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const getFeedbackTool = {
  name: "get_feedback",
  title: "Get Feedback",
  description:
    "Get one feedback report, including the full description. Workspace admins can read any report; everyone else can read only their own.",
  group: "feedback",
  inputSchema: {
    id: z.string().uuid().describe("Feedback report id"),
  },
  outputSchema: z.object({ feedback: feedbackItemSchema }),
  annotations: { readOnlyHint: true },
} as const satisfies McpToolDef;

export const FEEDBACK_TOOL_DEFS = [
  sendFeedbackTool,
  listFeedbackTool,
  getFeedbackTool,
  updateFeedbackTool,
] as const;
