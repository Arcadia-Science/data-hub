import type { NextRequest } from "next/server";
import { requireSession } from "@/lib/api/auth";
import { apiError, UNAUTHORIZED, VALIDATION_ERROR } from "@/lib/api/errors";
import {
  countFeedbackByStatus,
  createFeedback,
  FeedbackServiceError,
  listFeedback,
} from "@/lib/api/feedback";
import { serializeFeedback } from "@/lib/api/feedback-json";
import {
  FEEDBACK_PAGE_SIZE,
  feedbackContentSchema,
} from "@/lib/api/feedback-schema";
import {
  createFeedbackBody,
  listFeedbackQuery,
  readJsonBody,
} from "@/lib/api/openapi";
import { userIsAdmin } from "@/lib/api/user-admin";

// Feedback is session-only: a report belongs to the person who wrote it, and
// tokens do not stand in for a person.
export async function POST(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const body = await readJsonBody(request, createFeedbackBody);
  if (body instanceof Response) {
    return body;
  }

  const content = feedbackContentSchema.safeParse({
    kind: body.kind,
    title: body.title,
    description: body.description,
    attemptedAction: body.attempted_action,
    toolName: body.tool_name,
    errorMessage: body.error_message,
  });
  if (!content.success) {
    return apiError(400, VALIDATION_ERROR, "Invalid request body");
  }

  let result: Awaited<ReturnType<typeof createFeedback>>;
  try {
    result = await createFeedback({
      ...content.data,
      userId: authResult.userId,
      source: "web",
      pageUrl: body.page_url || null,
    });
  } catch (err) {
    if (err instanceof FeedbackServiceError) {
      return apiError(503, "FEEDBACK_UNAVAILABLE", err.message);
    }
    throw err;
  }

  return Response.json(
    { duplicate: result.duplicate, feedback: serializeFeedback(result.item) },
    { status: result.duplicate ? 200 : 201 }
  );
}

export async function GET(request: NextRequest) {
  const authResult = await requireSession();
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const params = request.nextUrl.searchParams;
  const query = listFeedbackQuery.safeParse({
    status: params.get("status") ?? undefined,
    kind: params.get("kind") ?? undefined,
    page: params.get("page") ?? undefined,
    per_page: params.get("per_page") ?? undefined,
  });
  if (!query.success) {
    return apiError(400, VALIDATION_ERROR, "Invalid query");
  }

  // The full list includes other people's email addresses, so only admins
  // see more than their own reports.
  const isAdmin = await userIsAdmin(authResult.userId);
  const perPage = query.data.per_page ?? FEEDBACK_PAGE_SIZE;
  const page = query.data.page ?? 1;
  const viewer = { viewerId: authResult.userId, isAdmin };

  let list: Awaited<ReturnType<typeof listFeedback>>;
  let counts: Awaited<ReturnType<typeof countFeedbackByStatus>>;
  try {
    [list, counts] = await Promise.all([
      listFeedback({
        ...viewer,
        status: query.data.status,
        kind: query.data.kind,
        limit: perPage,
        offset: (page - 1) * perPage,
      }),
      countFeedbackByStatus(viewer),
    ]);
  } catch (err) {
    if (err instanceof FeedbackServiceError) {
      return apiError(503, "FEEDBACK_UNAVAILABLE", err.message);
    }
    throw err;
  }

  return Response.json({
    feedback: list.items.map(serializeFeedback),
    total: list.total,
    counts,
  });
}
