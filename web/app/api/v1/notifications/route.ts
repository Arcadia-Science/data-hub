import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/api/auth";
import { apiError, UNAUTHORIZED, VALIDATION_ERROR } from "@/lib/api/errors";
import {
  countUnread,
  listNotifications,
  markRead,
} from "@/lib/api/notifications";

// Notification reads/writes are session-only — these are personal-UX
// surfaces, never invoked by the watcher / Lambda PATs, so they don't
// participate in the `Scope` vocabulary.

const PostBodySchema = z.object({
  ids: z.array(z.string().uuid()).optional(),
});

// ---------------------------------------------------------------------------
// GET /api/v1/notifications
//
// Returns `{ unreadCount, notifications }` for the bell popover. The
// `?unread_only=true` query parameter narrows the list itself; the count
// is always the unconditional unread total so the badge stays accurate.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await requireSession();
  if (!auth) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const unreadOnly = request.nextUrl.searchParams.get("unread_only") === "true";
  const [items, unreadCount] = await Promise.all([
    listNotifications(auth.userId, { unreadOnly }),
    countUnread(auth.userId),
  ]);

  return Response.json({
    unreadCount,
    notifications: items.map((n) => ({
      id: n.id,
      type: n.type,
      created_at: n.createdAt.toISOString(),
      read_at: n.readAt?.toISOString() ?? null,
      run_id: n.runId,
      run_display_id: n.runDisplayId,
      instrument_id: n.instrumentId,
      instrument_display_name: n.instrumentDisplayName,
      instrument_type: n.instrumentType,
      comment_id: n.commentId,
      comment_body: n.commentBody,
      actor: n.actor,
    })),
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/notifications  { ids?: string[] }
//
// Marks notifications read. Empty body or omitted `ids` marks everything
// unread for the user; an explicit array marks just those rows. The
// `where` clause always scopes to `userId`, so a malicious id list can't
// touch another user's rows.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await requireSession();
  if (!auth) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  let raw: unknown = {};
  // Empty body is fine — it means "mark all". Only error on outright
  // invalid JSON.
  const text = await request.text();
  if (text.length > 0) {
    try {
      raw = JSON.parse(text);
    } catch {
      return apiError(400, VALIDATION_ERROR, "Invalid JSON body");
    }
  }

  const parsed = PostBodySchema.safeParse(raw);
  if (!parsed.success) {
    return apiError(400, VALIDATION_ERROR, "Invalid request body", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    });
  }

  await markRead(auth.userId, parsed.data.ids);

  const unreadCount = await countUnread(auth.userId);
  return Response.json({ unreadCount });
}
