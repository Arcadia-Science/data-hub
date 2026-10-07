import { after } from "next/server";
import {
  apiError,
  LINEAR_UNAVAILABLE,
  UNAUTHORIZED,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { notifyFeedbackUpdated } from "@/lib/api/notifications";
import {
  getLinearWorkflowStateType,
  type LinearCredentials,
  LinearRequestError,
  listLinearIssueDetails,
} from "@/lib/linear/client";
import {
  claimLinearWebhookDelivery,
  getLinearCredentials,
  recordLinearWebhookReceived,
} from "@/lib/linear/config";
import {
  feedbackStatusFromLinearState,
  isLinearStateClosed,
  readFeedbackReport,
} from "@/lib/linear/feedback-link";
import {
  isFreshWebhookTimestamp,
  verifyLinearWebhookSignature,
} from "@/lib/linear/webhook";

// Linear posts here when an issue changes. The signature is checked before
// any work. Linear resends a delivery that takes longer than five seconds to
// answer, so the Linear lookups happen before the reply (a failure there
// answers 502 and Linear tries again) and the database writes and the Slack
// message happen after it.

interface PendingNotification {
  feedbackId: string;
  reporterUserId: string;
  stateName: string;
  status: "resolved" | "declined";
  title: string;
}

// A report notifies its reporter when its issue moves into a closed state
// from a state that was not closed. Moving from Done to Released stays quiet.
async function pendingNotification(
  credentials: LinearCredentials,
  body: { data?: { id?: string }; updatedFrom?: { stateId?: unknown } | null }
): Promise<PendingNotification | null> {
  const issueId = body.data?.id;
  const previousStateId = body.updatedFrom?.stateId;
  if (!issueId || typeof previousStateId !== "string") {
    return null;
  }

  const [issue] = await listLinearIssueDetails(credentials, [issueId]);
  if (!issue) {
    return null;
  }
  const status = feedbackStatusFromLinearState(issue.state.type);
  const report = readFeedbackReport(issue);
  if (status === "open" || !report) {
    return null;
  }

  // The payload names the previous state only by id. A state Linear no longer
  // knows is treated as open, so the reporter is told.
  const previousType = await getLinearWorkflowStateType(
    credentials,
    previousStateId
  );
  if (previousType && isLinearStateClosed(previousType)) {
    return null;
  }

  return {
    feedbackId: issue.id,
    reporterUserId: report.reporterUserId,
    title: report.title,
    status,
    stateName: issue.state.name,
  };
}

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
    data?: { id?: string };
    type?: string;
    updatedFrom?: { stateId?: unknown } | null;
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

  let notification: PendingNotification | null = null;
  if (body.type === "Issue" && body.action === "update") {
    try {
      notification = await pendingNotification(credentials, body);
    } catch (err) {
      if (err instanceof LinearRequestError) {
        return apiError(502, LINEAR_UNAVAILABLE, err.message);
      }
      throw err;
    }
  }

  const deliveryId = request.headers.get("linear-delivery");
  after(async () => {
    try {
      await recordLinearWebhookReceived();
      // The delivery is claimed before the reporter is told, so a failure
      // after this point is never repeated. Linear will not resend it either.
      if (notification && (await claimLinearWebhookDelivery(deliveryId))) {
        await notifyFeedbackUpdated(notification);
      }
    } catch (err) {
      console.error("[linear-webhook] Failed to finish a delivery:", err);
    }
  });
  return new Response(null, { status: 200 });
}
