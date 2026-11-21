import type { AuthInfo } from "@modelcontextprotocol/server";
import {
  loadTokenRefs,
  type TokenRef,
  tokenRefFor,
} from "@/lib/api/file-deleters";
import { lookupRunByNaturalKey, type RunFile } from "@/lib/api/instrument-runs";
import { userIsAdmin } from "@/lib/api/user-admin";
import { isStalledProcessing } from "@/lib/runs/stalled-processing";

/**
 * Success payload for MCP tools that declare `outputSchema`. Round-trips
 * through JSON so `content` text and `structuredContent` stay identical
 * (Dates become ISO strings) and SDK output validation can't diverge.
 */
export function structuredResult(data: unknown) {
  const json = JSON.stringify(data, null, 2);
  return {
    content: [{ type: "text" as const, text: json }],
    structuredContent: JSON.parse(json) as unknown,
  };
}

export function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export type McpErrorResult = ReturnType<typeof errorResult>;

// Auth middleware puts the authenticated user on `extra.userId`. Narrow with
// typeof instead of a cast so a malformed extra can't silently become a string.
export function getMcpUserId(
  authInfo: AuthInfo | undefined
): string | undefined {
  const userId = authInfo?.extra?.userId;
  return typeof userId === "string" ? userId : undefined;
}

// Trim a file row to the fields useful to an LLM listing a run's files.
// Internal S3 location (`s3Bucket`/`s3Key`) and the potentially large
// `metadata` jsonb are intentionally dropped — callers that need full detail
// for a specific file use the `get_file` tool. `deleterTokens` names the token
// behind `deletedByToken`; see `toMcpFiles`.
export function toMcpFile(
  f: RunFile,
  deleterTokens: ReadonlyMap<string, TokenRef>
) {
  return {
    id: f.id,
    filename: f.filename,
    relativePath: f.relativePath,
    category: f.category,
    status: f.status,
    sizeBytes: f.sizeBytes,
    contentType: f.contentType,
    errorMessage: f.errorMessage,
    uploadFailureReason: f.uploadFailureReason,
    createdAt: f.createdAt,
    uploadedAt: f.uploadedAt,
    processedAt: f.processedAt,
    stalled: isStalledProcessing(f),
    // Set only on a deleted file, which a list shows when asked to. Read like
    // a run's deleter: a user ID, or the token's id and name.
    deletedAt: f.deletedAt,
    deletedBy: f.deletedBy,
    deletedByToken: tokenRefFor(deleterTokens, f.deletedByToken),
  };
}

// `toMcpFile` for a list of rows, naming the tokens that deleted any of them
// with one query.
export async function toMcpFiles(rows: readonly RunFile[]) {
  const deleterTokens = await loadTokenRefs(rows.map((f) => f.deletedByToken));
  return rows.map((f) => toMcpFile(f, deleterTokens));
}

// Reads `users.is_admin` on every call. Unlike `requireMcpWrite`, a missing
// auth identity is a failure: we cannot tell whether the caller is an admin.
export async function requireMcpAdmin(
  authInfo: AuthInfo | undefined
): Promise<McpErrorResult | null> {
  const userId = getMcpUserId(authInfo);
  if (!userId) {
    return errorResult("Authenticated user not available on this session.");
  }
  if (await userIsAdmin(userId)) {
    return null;
  }
  return errorResult("Admin role required");
}

// Mutating MCP tools require the coarse OAuth `write` scope. Transport-level
// auth already enforces `read`; this is the per-tool gate for side effects.
//
// When `authInfo` is undefined we skip the check: production traffic always
// has it (enforced by the MCP auth wrapper in the route), and the in-memory
// test transport intentionally omits it. Downstream user-identity checks
// (e.g. `resolveAttributionTarget`) still reject the call when a user id is
// required.
export function requireMcpWrite(
  authInfo: AuthInfo | undefined
): McpErrorResult | null {
  if (!authInfo) {
    return null;
  }
  if (authInfo.scopes?.includes("write")) {
    return null;
  }
  return errorResult("Token is missing required scope: write");
}

type AttributionResolution =
  | { ok: true; userId: string; runUuid: string; runId: string }
  | { ok: false; error: McpErrorResult };

// Shared resolution step for claim_run / unclaim_run. The authenticated user
// id is pulled only from authInfo — never from an argument — to preserve the
// "no spoofable user id" invariant the REST route at
// /api/v1/instruments/:instrumentId/runs/:runId/attributions/me enforces.
export async function resolveAttributionTarget(
  authInfo: AuthInfo | undefined,
  instrumentId: string,
  runId: string
): Promise<AttributionResolution> {
  const userId = getMcpUserId(authInfo);
  if (!userId) {
    return {
      ok: false,
      error: errorResult("Authenticated user not available on this session."),
    };
  }
  const run = await lookupRunByNaturalKey(instrumentId, runId);
  if (!run) {
    return {
      ok: false,
      error: errorResult(
        `Run '${runId}' not found for instrument '${instrumentId}'.`
      ),
    };
  }
  return { ok: true, userId, runUuid: run.id, runId: run.runId };
}
