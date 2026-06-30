import { eq } from "drizzle-orm";
import { after } from "next/server";
import { db } from "@/lib/db";
import { files, instrumentRuns } from "@/lib/db/schema";
import { hasInvokeCredentials, signLambdaInvoke } from "@/lib/lambda";

const REPROCESSABLE_STATUSES = ["failed", "completed"];

function getLambdaUrl(): string | null {
  const url = process.env.LAMBDA_FUNCTION_URL;
  if (!(url && hasInvokeCredentials())) {
    return null;
  }
  return url;
}

export type ReprocessResult =
  | { ok: true; fileId: number }
  | {
      ok: false;
      status: number;
      code: "NOT_FOUND" | "CONFLICT" | "INTERNAL_ERROR";
      message: string;
      details?: Record<string, unknown>;
    };

// Shared core for file reprocessing, used by both the REST route
// (/api/v1/files/:fileId/reprocess) and the MCP `reprocess_file` tool.
//
// Validates the file state machine, transitions status to "processing",
// and schedules a Lambda invocation via `after()` so it runs after the
// response is sent but while the runtime stays warm.
export async function reprocessFile(fileId: number): Promise<ReprocessResult> {
  const [file] = await db
    .select()
    .from(files)
    .where(eq(files.id, fileId))
    .limit(1);

  if (!file) {
    return {
      ok: false,
      status: 404,
      code: "NOT_FOUND",
      message: `File '${fileId}' not found`,
    };
  }

  if (file.deletedAt) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "Cannot reprocess a soft-deleted file",
    };
  }

  if (!REPROCESSABLE_STATUSES.includes(file.status)) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: `Cannot reprocess a file in '${file.status}' status — only 'failed' or 'completed' files can be reprocessed`,
    };
  }

  if (!(file.s3Bucket && file.s3Key)) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "File has no S3 location — it cannot be reprocessed",
    };
  }

  const [parentRun] = await db
    .select({ deletedAt: instrumentRuns.deletedAt })
    .from(instrumentRuns)
    .where(eq(instrumentRuns.id, file.instrumentRunId))
    .limit(1);

  if (parentRun?.deletedAt) {
    return {
      ok: false,
      status: 409,
      code: "CONFLICT",
      message: "Cannot reprocess a file whose parent run is soft-deleted",
    };
  }

  const lambdaUrl = getLambdaUrl();
  if (!lambdaUrl) {
    return {
      ok: false,
      status: 503,
      code: "INTERNAL_ERROR",
      message: "Lambda reprocessing is not configured",
    };
  }

  await db
    .update(files)
    .set({
      status: "processing",
      processedAt: null,
      errorMessage: null,
    })
    .where(eq(files.id, fileId));

  // Build a synthetic S3 event matching the shape parse_s3_event expects.
  // Real S3 events use application/x-www-form-urlencoded encoding for the
  // object key: "+" → "%2B", spaces → "+", and "/" stays literal.
  // encodeURIComponent gets most of the way there ("%2B" for "+", "%20"
  // for space, "%2F" for "/"), and we restore literal "/" to match S3's
  // format. The Lambda decodes with urllib.parse.unquote_plus, which
  // turns both "+" and "%20" back into a space, so this payload
  // round-trips identically to a real S3 event notification.
  const s3Event = {
    Records: [
      {
        s3: {
          bucket: { name: file.s3Bucket },
          object: {
            key: encodeURIComponent(file.s3Key).replaceAll("%2F", "/"),
          },
        },
      },
    ],
  };

  // The Lambda Function URL uses BUFFERED mode, so awaiting the response
  // would block until processing finishes. `after` defers the invocation
  // until the HTTP response is flushed; the runtime stays warm until the
  // callback completes, so error logging is reliable. The Lambda calls
  // back via PATCH /api/v1/files/:fileId with the final status.
  after(async () => {
    try {
      const signed = await signLambdaInvoke({
        url: lambdaUrl,
        body: JSON.stringify(s3Event),
      });
      const res = await fetch(signed);
      if (!res.ok) {
        console.error(
          `Lambda returned ${res.status} for file ${fileId}:`,
          await res.text().catch(() => "")
        );
      }
    } catch (err) {
      console.error(`Failed to invoke Lambda for file ${fileId}:`, err);
    }
  });

  return { ok: true, fileId };
}
