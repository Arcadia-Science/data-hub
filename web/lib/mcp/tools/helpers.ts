import type { AuthInfo } from "@modelcontextprotocol/server";
import { lookupRunByNaturalKey, type RunFile } from "@/lib/api/instrument-runs";

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
// for a specific file use the `get_file` tool.
export function toMcpFile(f: RunFile) {
  return {
    id: f.id,
    filename: f.filename,
    relativePath: f.relativePath,
    category: f.category,
    status: f.status,
    sizeBytes: f.sizeBytes,
    contentType: f.contentType,
    errorMessage: f.errorMessage,
    createdAt: f.createdAt,
    uploadedAt: f.uploadedAt,
    processedAt: f.processedAt,
  };
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
  | { ok: true; userId: string; runUuid: string }
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
  return { ok: true, userId, runUuid: run.id };
}
