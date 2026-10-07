import { requireAdmin } from "@/lib/api/auth";
import { apiErrorFromResult } from "@/lib/api/errors";
import { createTestFeedback } from "@/lib/api/feedback";
import { serializeFeedback } from "@/lib/api/feedback-json";

export async function POST() {
  const authResult = await requireAdmin();
  if (authResult instanceof Response) {
    return authResult;
  }

  const result = await createTestFeedback(authResult.userId);
  if (!result.ok) {
    return apiErrorFromResult(result);
  }

  return Response.json(
    {
      duplicate: result.duplicate,
      feedback: serializeFeedback(result.item),
    },
    { status: result.duplicate ? 200 : 201 }
  );
}
