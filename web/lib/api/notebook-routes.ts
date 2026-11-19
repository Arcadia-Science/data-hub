import type { AuthResult } from "@/lib/api/auth";
import { apiError, VALIDATION_ERROR } from "@/lib/api/errors";
import type { RunKey } from "@/lib/api/notebooks";

// Shared by the REST routes under `/api/v1/notebooks`.

/**
 * The 403 message for a token that registered a watcher, on the routes that
 * create, edit, delete, or restore a notebook. The watcher never manages
 * notebooks, so such a token may only add or remove its own instrument's
 * runs. Each route passes it to `refuseWatcherTokenAdmin`.
 */
export const WATCHER_TOKEN_NOTEBOOK_REFUSAL =
  "A watcher's token can't create or change notebooks";

/** The runs a request body names, as the notebooks service takes them. */
export function runKeysFromBody(
  runs: ReadonlyArray<{ instrument_id: string; run_id: string }>
): RunKey[] {
  return runs.map((run) => ({
    instrumentId: run.instrument_id,
    runId: run.run_id,
  }));
}

/**
 * The owner a request body names. `"me"` means the signed-in person, which a
 * token can't use because no person stands behind it. The web app's forms
 * send `"me"` to suggest the viewer as owner.
 */
export function ownerFromBody<T extends string | null | undefined>(
  authResult: AuthResult,
  ownerId: T
): string | T | Response {
  if (ownerId !== "me") {
    return ownerId;
  }
  if (authResult.authMethod === "session") {
    return authResult.userId;
  }
  return apiError(
    400,
    VALIDATION_ERROR,
    'A token can\'t use owner_id "me". Pass a user ID.'
  );
}
