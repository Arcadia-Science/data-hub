import {
  bearerSecurity,
  errorResponses,
  jsonResponse,
  registry,
} from "../registry";
import {
  createFeedbackBody,
  feedbackCreated,
  feedbackDetail,
  feedbackList,
  listFeedbackQuery,
  updateFeedbackBody,
} from "../schemas/feedback";

registry.registerPath({
  method: "post",
  path: "/feedback",
  operationId: "createFeedback",
  summary: "Send feedback",
  description:
    "Any authenticated session or personal access token. Saves a bug report or request about Data Hub and notifies workspace admins.",
  tags: ["Feedback"],
  security: bearerSecurity,
  request: {
    body: {
      content: { "application/json": { schema: createFeedbackBody } },
    },
  },
  responses: {
    200: jsonResponse(
      "An open report with this title already exists. Nothing new was saved.",
      feedbackCreated
    ),
    201: jsonResponse("The saved feedback report.", feedbackCreated),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: "get",
  path: "/feedback",
  operationId: "listFeedback",
  summary: "List feedback",
  description:
    "Callers with the `feedback:admin` scope see every report. Everyone else sees only their own, including an admin using a token without that scope.",
  tags: ["Feedback"],
  security: bearerSecurity,
  request: {
    query: listFeedbackQuery,
  },
  responses: {
    200: jsonResponse("Feedback reports visible to the caller.", feedbackList),
    ...errorResponses(),
  },
});

registry.registerPath({
  method: "patch",
  path: "/feedback/{id}",
  operationId: "updateFeedback",
  summary: "Update feedback status",
  description:
    "Workspace admin only. Requires the `feedback:admin` scope (browser sessions have it). Resolving or declining notifies the reporter. A note-only save does not.",
  tags: ["Feedback"],
  security: bearerSecurity,
  request: {
    params: feedbackDetail.pick({ id: true }),
    body: {
      content: { "application/json": { schema: updateFeedbackBody } },
    },
  },
  responses: {
    200: jsonResponse("The updated feedback report.", feedbackDetail),
    ...errorResponses(),
  },
});
