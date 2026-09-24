import { z } from "zod";
import {
  FEEDBACK_DESCRIPTION_MAX,
  FEEDBACK_DETAIL_MAX,
  FEEDBACK_LIST_MAX,
  FEEDBACK_TITLE_MAX,
  feedbackKindSchema,
  feedbackStatusSchema,
} from "@/lib/api/feedback-schema";
import type { McpToolDef } from "@/lib/mcp/catalog/types";
import {
  listFeedbackOutputSchema,
  sendFeedbackOutputSchema,
  updateFeedbackOutputSchema,
} from "./feedback.output";

const optionalDetail = z
  .string()
  .trim()
  .max(FEEDBACK_DETAIL_MAX)
  .optional()
  .describe("Optional extra detail");

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
    attemptedAction: optionalDetail.describe("What the user was trying to do"),
    toolName: optionalDetail.describe("MCP tool involved, if any"),
    errorMessage: optionalDetail.describe("Error text, if any"),
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
  description:
    "List feedback reports. Workspace admins see every report; everyone else sees only their own. Filter by status or kind.",
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
    "Set a feedback report's status to open, resolved, or declined, with an optional note. Workspace admin only, and requires the write scope. Resolving or declining notifies the reporter.",
  group: "feedback",
  inputSchema: {
    id: z.string().uuid().describe("Feedback report id"),
    status: feedbackStatusSchema.describe("open, resolved, or declined"),
    note: z
      .string()
      .trim()
      .max(FEEDBACK_DETAIL_MAX)
      .optional()
      .describe("Note shown to the reporter"),
  },
  outputSchema: updateFeedbackOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
} as const satisfies McpToolDef;

export const FEEDBACK_TOOL_DEFS = [
  sendFeedbackTool,
  listFeedbackTool,
  updateFeedbackTool,
] as const;
