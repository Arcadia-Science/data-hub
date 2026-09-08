import {
  bearerSecurity,
  errorResponses,
  jsonResponse,
  registry,
} from "../registry";
import {
  dispatchNotificationsBody,
  dispatchNotificationsResult,
} from "../schemas/notifications";

registry.registerPath({
  method: "post",
  path: "/notifications/dispatch",
  operationId: "dispatchNotifications",
  summary: "Send a notification to users",
  description:
    "Requires scope `notifications:create`. PAT only; browser sessions are rejected. Posts a free-text `generic` notification to each recipient, optionally anchored to a run. Delivery is per-recipient preference: in-app bell and/or Slack DM. Exact repeats of an unread message are skipped, so retries are safe.",
  tags: ["Notifications"],
  security: bearerSecurity,
  request: {
    body: {
      content: { "application/json": { schema: dispatchNotificationsBody } },
    },
  },
  responses: {
    201: jsonResponse("Dispatch result.", dispatchNotificationsResult),
    ...errorResponses(),
  },
});
