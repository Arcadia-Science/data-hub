import { eq } from "drizzle-orm";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
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
      deletedBy?: string | null;
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

// Shared by REST DELETE and MCP `delete_run` so soft-delete semantics stay identical.
export async function softDeleteRun(input: {
  instrumentId: string;
  runId: string;
  deletedBy: string | null;
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
    // Idempotent: the run is already soft-deleted, so report success with the
    // existing deletion metadata instead of a 409 conflict.
    return {
      ok: true,
      id: run.id,
      instrumentId: run.instrumentId,
      runId: run.runId,
      deletedAt: run.deletedAt,
      deletedBy: run.deletedBy,
      alreadyApplied: true,
    };
  }

  const now = new Date();
  await db
    .update(instrumentRuns)
    .set({ deletedAt: now, deletedBy: input.deletedBy })
    .where(eq(instrumentRuns.id, run.id));

  return {
    ok: true,
    id: run.id,
    instrumentId: run.instrumentId,
    runId: run.runId,
    deletedAt: now,
    deletedBy: input.deletedBy,
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
    .set({ deletedAt: null, deletedBy: null })
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
