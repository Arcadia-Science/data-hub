import { and, eq, isNull, TransactionRollbackError } from "drizzle-orm";
import {
  type ActorRef,
  actorColumns,
  actorToken,
  actorUser,
} from "@/lib/api/actor";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { cancelRunUploadRequests } from "@/lib/api/watchers";
import { db } from "@/lib/db";
import { instrumentRuns } from "@/lib/db/schema";

export type RunLifecycleResult =
  | {
      ok: true;
      // Internal run UUID. The v1 restore endpoint has always echoed this, so
      // it's carried through the shared result to preserve that contract.
      id: string;
      instrumentId: string;
      runId: string;
      deletedAt: Date | null;
      // Who deleted the run: a person's user id, or the token that did.
      // Both null for an active run, or one deleted before the actor was
      // recorded.
      deletedBy?: string | null;
      deletedByToken?: { id: string; name: string } | null;
      // True when the run was already in the requested state, so the call made
      // no change. Lets delete/restore stay idempotent (success, not 409) while
      // still letting callers tell a no-op apart from a real transition.
      alreadyApplied: boolean;
    }
  | {
      ok: false;
      status: number;
      code: "NOT_FOUND" | "CONFLICT";
      message: string;
    };

// Idempotent delete: the run is already soft-deleted, so report success with
// the existing deletion metadata instead of a 409 conflict.
function alreadyDeleted(
  run: NonNullable<Awaited<ReturnType<typeof lookupRunByNaturalKey>>>
): RunLifecycleResult {
  return {
    ok: true,
    id: run.id,
    instrumentId: run.instrumentId,
    runId: run.runId,
    deletedAt: run.deletedAt,
    deletedBy: actorUser(run.deletedBy)?.userId ?? null,
    deletedByToken: actorToken(run.deletedBy),
    alreadyApplied: true,
  };
}

// Shared by REST DELETE and MCP `delete_run` so soft-delete semantics stay identical.
export async function softDeleteRun(input: {
  instrumentId: string;
  runId: string;
  actor: ActorRef | null;
}): Promise<RunLifecycleResult> {
  const run = await lookupRunByNaturalKey(input.instrumentId, input.runId);
  if (!run) {
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: `Run '${input.runId}' not found for instrument '${input.instrumentId}'`,
    };
  }

  if (run.deletedAt) {
    return alreadyDeleted(run);
  }

  const now = new Date();
  const { userId, tokenId } = actorColumns(input.actor);
  // A deleted run refuses uploads, so cancel the ones already requested in the
  // same transaction. Otherwise they would stay in the watcher's queue. A
  // restore does not bring them back: someone has to request them again.
  //
  // The cancel comes before the run update on purpose. It locks the files and
  // then the run, the same order as the other paths that revert requests, so
  // the two can't wait for each other. The update only changes a run that is
  // still live. If another delete got there first it changes nothing, and
  // rolling back undoes the cancel, so the second delete records nothing.
  let deleted = true;
  try {
    await db.transaction(async (tx) => {
      await cancelRunUploadRequests(
        { id: run.id, instrumentId: run.instrumentId, runId: run.runId },
        tx
      );
      const changed = await tx
        .update(instrumentRuns)
        .set({ deletedAt: now, deletedBy: userId, deletedByToken: tokenId })
        .where(
          and(eq(instrumentRuns.id, run.id), isNull(instrumentRuns.deletedAt))
        )
        .returning({ id: instrumentRuns.id });
      if (changed.length === 0) {
        tx.rollback();
      }
    });
  } catch (error) {
    if (!(error instanceof TransactionRollbackError)) {
      throw error;
    }
    deleted = false;
  }

  if (!deleted) {
    const current = await lookupRunByNaturalKey(
      input.instrumentId,
      input.runId
    );
    if (current?.deletedAt) {
      return alreadyDeleted(current);
    }
    // Someone restored the run right after deleting it.
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: `Run '${input.runId}' changed while it was being deleted. Try again.`,
    };
  }

  return {
    ok: true,
    id: run.id,
    instrumentId: run.instrumentId,
    runId: run.runId,
    deletedAt: now,
    deletedBy: userId,
    deletedByToken:
      input.actor?.kind === "token"
        ? { id: input.actor.tokenId, name: input.actor.tokenName }
        : null,
    alreadyApplied: false,
  };
}

// Shared by REST restore and MCP `restore_run`.
export async function restoreRun(
  instrumentId: string,
  runId: string
): Promise<RunLifecycleResult> {
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: `Run '${runId}' not found for instrument '${instrumentId}'`,
    };
  }

  if (!run.deletedAt) {
    // Idempotent: the run is already live, so there's nothing to clear — report
    // success rather than a 409 conflict.
    return {
      ok: true,
      id: run.id,
      instrumentId: run.instrumentId,
      runId: run.runId,
      deletedAt: null,
      alreadyApplied: true,
    };
  }

  await db
    .update(instrumentRuns)
    .set({ deletedAt: null, deletedBy: null, deletedByToken: null })
    .where(eq(instrumentRuns.id, run.id));

  const restored = await lookupRunByNaturalKey(instrumentId, runId);
  if (!restored) {
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: `Run '${runId}' could not be found after restore`,
    };
  }

  return {
    ok: true,
    id: restored.id,
    instrumentId: restored.instrumentId,
    runId: restored.runId,
    deletedAt: restored.deletedAt,
    alreadyApplied: false,
  };
}
