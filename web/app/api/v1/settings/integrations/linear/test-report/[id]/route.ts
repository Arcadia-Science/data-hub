import type { NextRequest } from "next/server";
import { requireAdmin } from "@/lib/api/auth";
import { apiError, apiErrorFromResult, NOT_FOUND } from "@/lib/api/errors";
import { getTestReportStatus } from "@/lib/api/feedback";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const authResult = await requireAdmin();
  if (authResult instanceof Response) {
    return authResult;
  }

  const { id } = await context.params;
  const result = await getTestReportStatus({
    issueId: id,
    userId: authResult.userId,
  });
  if (!result.ok) {
    return apiErrorFromResult(result);
  }
  if (!result.status) {
    return apiError(404, NOT_FOUND, "That test report was not found.");
  }

  const status = result.status;
  return Response.json({
    id: status.id,
    identifier: status.identifier,
    url: status.url,
    state_name: status.stateName,
    state_type: status.stateType,
    team_name: status.teamName,
    label_name: status.labelName,
    closed: status.closed,
    update_received: status.updateReceived,
    notification_at: status.notificationAt,
    notifications_enabled: status.notificationsEnabled,
    webhook_rejections: status.rejections,
    last_webhook_rejection_reason: status.rejectionReason,
  });
}
