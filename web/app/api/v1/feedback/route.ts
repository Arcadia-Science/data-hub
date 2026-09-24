import type { NextRequest } from "next/server";
import { authorizeAuthenticated } from "@/lib/api/auth";
import { apiError, VALIDATION_ERROR } from "@/lib/api/errors";
import {
  countFeedbackByStatus,
  createFeedback,
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

export async function POST(request: NextRequest) {
  const authResult = await authorizeAuthenticated(request);
  if (authResult instanceof Response) {
    return authResult;
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

  const result = await createFeedback({
    ...content.data,
    userId: authResult.userId,
    source: "web",
    pageUrl: body.page_url || null,
  });

  return Response.json(
    { duplicate: result.duplicate, feedback: serializeFeedback(result.item) },
    { status: 201 }
  );
}

export async function GET(request: NextRequest) {
  const authResult = await authorizeAuthenticated(request);
  if (authResult instanceof Response) {
    return authResult;
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

  const isAdmin = await userIsAdmin(authResult.userId);
  const perPage = query.data.per_page ?? FEEDBACK_PAGE_SIZE;
  const page = query.data.page ?? 1;
  const viewer = { viewerId: authResult.userId, isAdmin };

  const [list, counts] = await Promise.all([
    listFeedback({
      ...viewer,
      status: query.data.status,
      kind: query.data.kind,
      limit: perPage,
      offset: (page - 1) * perPage,
    }),
    countFeedbackByStatus(viewer),
  ]);

  return Response.json({
    feedback: list.items.map(serializeFeedback),
    total: list.total,
    counts,
  });
}
