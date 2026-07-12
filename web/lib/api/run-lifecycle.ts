import { eq } from "drizzle-orm";
import { lookupRunByNaturalKey } from "@/lib/api/instrument-runs";
import { db } from "@/lib/db";
import { instrumentRuns } from "@/lib/db/schema";

export type RunLifecycleResult =
  | {
      ok: true;
      instrumentId: string;
      runId: string;
      deletedAt: Date | null;
      deletedBy?: string | null;
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
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "Run is already deleted",
    };
  }

  const now = new Date();
  await db
    .update(instrumentRuns)
    .set({ deletedAt: now, deletedBy: input.deletedBy })
    .where(eq(instrumentRuns.id, run.id));

  return {
    ok: true,
    instrumentId: run.instrumentId,
    runId: run.runId,
    deletedAt: now,
    deletedBy: input.deletedBy,
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
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "Run is not deleted — nothing to restore",
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
    instrumentId: restored.instrumentId,
    runId: restored.runId,
    deletedAt: restored.deletedAt,
  };
}
