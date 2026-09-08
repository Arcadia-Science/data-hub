import { inArray } from "drizzle-orm";
import { after, type NextRequest } from "next/server";
import { authorizeToken } from "@/lib/api/auth";
import { apiError, CONFLICT, VALIDATION_ERROR } from "@/lib/api/errors";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { notifyGeneric } from "@/lib/api/notifications";
import { dispatchNotificationsBody, readJsonBody } from "@/lib/api/openapi";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { deliverSlackDms } from "@/lib/slack/dm";

// ---------------------------------------------------------------------------
// POST /api/v1/notifications/dispatch
//
// Machine-facing notification creation: an integration posts a free-text
// message addressed to specific users, optionally anchored to a run. Each
// recipient's per-channel preferences decide delivery (in-app bell and/or
// Slack DM); exact repeats of an unread message are skipped so retries are
// safe.
//
// PAT-only: a browser session's `*` scope would let any member spam other
// users' bells and Slack DMs — the same reasoning as run creation.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const authResult = await authorizeToken(request, "notifications:create");
  if (authResult instanceof Response) {
    return authResult;
  }

  const body = await readJsonBody(request, dispatchNotificationsBody);
  if (body instanceof Response) {
    return body;
  }

  // Resolve the optional run anchor by natural key.
  let run:
    | {
        internalId: string;
        instrumentId: string;
        instrumentDisplayName: string;
        runDisplayId: string;
      }
    | undefined;
  if (body.run) {
    const found = await lookupRunByNaturalKey(
      body.run.instrument_id,
      body.run.run_id
    );
    if (!found) {
      return apiError(
        400,
        VALIDATION_ERROR,
        `Run '${body.run.run_id}' not found for instrument '${body.run.instrument_id}'`
      );
    }
    if (found.deletedAt) {
      return apiError(
        409,
        CONFLICT,
        "Cannot attach a notification to a soft-deleted run"
      );
    }
    run = {
      internalId: found.id,
      instrumentId: found.instrumentId,
      instrumentDisplayName: found.instrumentDisplayName,
      runDisplayId: found.runId,
    };
  }

  // Validate recipients and resolve the actor's display name in one lookup.
  const requestedIds = [...new Set(body.user_ids)];
  const lookupIds = [...new Set([...requestedIds, authResult.userId])];
  const userRows = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .where(inArray(users.id, lookupIds));
  const byId = new Map(userRows.map((row) => [row.id, row]));

  const validRecipientIds = requestedIds.filter((id) => byId.has(id));
  const unknownUserIds = requestedIds.filter((id) => !byId.has(id));
  const actor = byId.get(authResult.userId);
  const actorDisplayName = actor?.name ?? actor?.email ?? "Someone";

  const result = await notifyGeneric({
    actorUserId: authResult.userId,
    actorDisplayName,
    recipientUserIds: validRecipientIds,
    message: body.message,
    run,
    origin: new URL(request.url).origin,
  });

  // Slack is a best-effort side channel: DMs fire after the response so
  // Slack latency or an outage never delays or blocks the in-app insert.
  if (result.slackJobs.length > 0) {
    after(async () => {
      await deliverSlackDms(result.slackJobs);
    });
  }

  return Response.json(
    {
      notified_user_ids: result.notifiedUserIds,
      skipped_user_ids: [...unknownUserIds, ...result.skippedUserIds],
    },
    { status: 201 }
  );
}
