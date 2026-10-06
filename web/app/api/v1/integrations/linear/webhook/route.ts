import { apiError, UNAUTHORIZED, VALIDATION_ERROR } from "@/lib/api/errors";
import { notifyFeedbackUpdated } from "@/lib/api/notifications";
import {
  LinearRequestError,
  listLinearIssueDetails,
} from "@/lib/linear/client";
import {
  getLinearCredentials,
  recordLinearWebhookReceived,
} from "@/lib/linear/config";
import { feedbackStatusFromLinearState } from "@/lib/linear/feedback-link";
import {
  isFreshWebhookTimestamp,
  verifyLinearWebhookSignature,
} from "@/lib/linear/webhook";

// Linear posts here when an issue changes. The signature is checked before
// any work, and a state move into completed or canceled tells the reporter.

export async function POST(request: Request) {
  const rawBody = await request.text();
  const credentials = await getLinearCredentials();
  if (!credentials?.webhookSecret) {
    return apiError(401, UNAUTHORIZED, "Linear webhook is not configured");
  }
  if (
    !verifyLinearWebhookSignature(
      rawBody,
      request.headers.get("linear-signature"),
      credentials.webhookSecret
    )
  ) {
    return apiError(401, UNAUTHORIZED, "Invalid Linear signature");
  }

  let body: {
    action?: string;
    data?: { id?: string; title?: string };
    type?: string;
    updatedFrom?: Record<string, unknown>;
    webhookTimestamp?: number;
  };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
  }
  if (!isFreshWebhookTimestamp(body.webhookTimestamp ?? Number.NaN)) {
    return apiError(401, UNAUTHORIZED, "Linear webhook is too old");
  }

  await recordLinearWebhookReceived();

  const stateChanged =
    body.updatedFrom != null &&
    ("stateId" in body.updatedFrom || "state" in body.updatedFrom);
  if (body.type !== "Issue" || body.action !== "update" || !stateChanged) {
    return new Response(null, { status: 200 });
  }
  const issueId = body.data?.id;
  if (!issueId) {
    return new Response(null, { status: 200 });
  }

  let issue:
    | Awaited<ReturnType<typeof listLinearIssueDetails>>[number]
    | undefined;
  try {
    [issue] = await listLinearIssueDetails(credentials, [issueId]);
  } catch (err) {
    if (err instanceof LinearRequestError) {
      return apiError(500, "LINEAR_UNAVAILABLE", err.message);
    }
    throw err;
  }
  if (!issue) {
    return new Response(null, { status: 200 });
  }

  const status = feedbackStatusFromLinearState(issue.state.type);
  if (status !== "resolved" && status !== "declined") {
    return new Response(null, { status: 200 });
  }
  const attachment = issue.attachments.nodes.find((item) =>
    item.url.includes("/feedback/r/")
  );
  const reporterUserId = attachment?.metadata.reporterUserId;
  const title = attachment?.metadata.title;
  if (typeof reporterUserId !== "string" || typeof title !== "string") {
    return new Response(null, { status: 200 });
  }

  await notifyFeedbackUpdated({
    feedbackId: issue.id,
    reporterUserId,
    title,
    status,
    stateName: issue.state.name,
  });
  return new Response(null, { status: 200 });
}
