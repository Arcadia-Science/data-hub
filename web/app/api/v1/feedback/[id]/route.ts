import type { NextRequest } from "next/server";
import { authorizeAuthenticated, requireUserIsAdmin } from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { updateFeedback } from "@/lib/api/feedback";
import { serializeFeedback } from "@/lib/api/feedback-json";
import { readJsonBody, updateFeedbackBody } from "@/lib/api/openapi";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const authResult = await authorizeAuthenticated(request);
  if (authResult instanceof Response) {
    return authResult;
  }

  const adminError = await requireUserIsAdmin(authResult.userId);
  if (adminError) {
    return adminError;
  }

  const { id } = await context.params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  ) {
    return apiError(400, VALIDATION_ERROR, "Invalid feedback id");
  }

  const body = await readJsonBody(request, updateFeedbackBody);
  if (body instanceof Response) {
    return body;
  }

  const updated = await updateFeedback({
    id,
    adminUserId: authResult.userId,
    status: body.status,
    note: body.note === undefined ? undefined : body.note.trim() || null,
  });
  if (!updated) {
    return apiError(404, NOT_FOUND, "Feedback not found");
  }

  return Response.json(serializeFeedback(updated));
}
