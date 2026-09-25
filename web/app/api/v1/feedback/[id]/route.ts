import type { NextRequest } from "next/server";
import { authorize, requireUserIsAdmin } from "@/lib/api/auth";
import { apiError, NOT_FOUND, VALIDATION_ERROR } from "@/lib/api/errors";
import { updateFeedback } from "@/lib/api/feedback";
import { serializeFeedback } from "@/lib/api/feedback-json";
import { readJsonBody, updateFeedbackBody } from "@/lib/api/openapi";
import { isValidUUID } from "@/lib/api/validators";

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const authResult = await authorize(request, "feedback:admin");
  if (authResult instanceof Response) {
    return authResult;
  }

  const adminError = await requireUserIsAdmin(authResult.userId);
  if (adminError) {
    return adminError;
  }

  const { id } = await context.params;
  if (!isValidUUID(id)) {
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
