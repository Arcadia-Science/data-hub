import { authenticateRequest } from "@/lib/api/auth";
import {
  apiError,
  CONFLICT,
  INTERNAL_ERROR,
  NOT_FOUND,
  UNAUTHORIZED,
  VALIDATION_ERROR,
} from "@/lib/api/errors";
import { db } from "@/lib/db";
import { files, instrumentRuns, runReportData } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

type RouteContext = {
  params: Promise<{ fileId: string }>;
};

const REPROCESSABLE_STATUSES = ["failed", "completed"];

function getLambdaConfig() {
  const url = process.env.LAMBDA_FUNCTION_URL;
  const token = process.env.LAMBDA_INVOKE_TOKEN;
  if (!url || !token) return null;
  return { url, token };
}

// ---------------------------------------------------------------------------
// POST /api/v1/files/:fileId/reprocess
//
// Transitions a failed or completed file back to "processing" and invokes
// the Lambda Function URL to re-run the instrument's process_file workflow.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest, { params }: RouteContext) {
  const authResult = await authenticateRequest(request);
  if (!authResult) {
    return apiError(401, UNAUTHORIZED, "Authentication required");
  }

  const { fileId } = await params;
  const numericId = parseInt(fileId, 10);
  if (isNaN(numericId)) {
    return apiError(400, VALIDATION_ERROR, "Invalid file ID");
  }

  const [file] = await db
    .select()
    .from(files)
    .where(eq(files.id, numericId))
    .limit(1);

  if (!file) {
    return apiError(404, NOT_FOUND, `File '${fileId}' not found`);
  }

  if (file.deletedAt) {
    return apiError(409, CONFLICT, "Cannot reprocess a soft-deleted file");
  }

  if (!REPROCESSABLE_STATUSES.includes(file.status)) {
    return apiError(
      409,
      CONFLICT,
      `Cannot reprocess a file in '${file.status}' status — only 'failed' or 'completed' files can be reprocessed`
    );
  }

  if (!file.s3Bucket || !file.s3Key) {
    return apiError(
      409,
      CONFLICT,
      "File has no S3 location — it cannot be reprocessed"
    );
  }

  // Verify parent run is not soft-deleted.
  const [parentRun] = await db
    .select({ deletedAt: instrumentRuns.deletedAt })
    .from(instrumentRuns)
    .where(eq(instrumentRuns.id, file.instrumentRunId))
    .limit(1);

  if (parentRun?.deletedAt) {
    return apiError(
      409,
      CONFLICT,
      "Cannot reprocess a file whose parent run is soft-deleted"
    );
  }

  const lambda = getLambdaConfig();
  if (!lambda) {
    return apiError(
      503,
      INTERNAL_ERROR,
      "Lambda reprocessing is not configured"
    );
  }

  // Transition to "processing": clear previous error and report data.
  await db.transaction(async (tx) => {
    await tx.delete(runReportData).where(eq(runReportData.fileId, numericId));
    await tx
      .update(files)
      .set({
        status: "processing",
        processedAt: null,
        errorMessage: null,
      })
      .where(eq(files.id, numericId));
  });

  // Build a synthetic S3 event matching the shape parse_s3_event expects.
  // Real S3 events use application/x-www-form-urlencoded encoding for the
  // object key: "+" → "%2B", spaces → "+", and "/" stays literal.
  // We replicate that with encodeURIComponent (which gives "%2B" for "+")
  // then restore literal "/" to match S3's format.  The Lambda decodes
  // with urllib.parse.unquote, which handles both "%2F" and "/" correctly,
  // but keeping "/" literal makes the event payload identical to what S3
  // would actually send.
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

  // Invoke the Lambda Function URL. We await the HTTP response (not the
  // Lambda's processing) so we can roll back if the invocation itself fails.
  // The Lambda will call back via PATCH /api/v1/files/:fileId when done.
  let lambdaRes: Response;
  try {
    lambdaRes = await fetch(lambda.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${lambda.token}`,
      },
      body: JSON.stringify(s3Event),
    });
  } catch (err) {
    console.error(`Failed to invoke Lambda for file ${numericId}:`, err);
    await db
      .update(files)
      .set({ status: file.status, errorMessage: file.errorMessage })
      .where(eq(files.id, numericId));
    return apiError(502, INTERNAL_ERROR, "Failed to reach the Lambda function");
  }

  if (!lambdaRes.ok) {
    console.error(`Lambda returned ${lambdaRes.status} for file ${numericId}`);
    await db
      .update(files)
      .set({ status: file.status, errorMessage: file.errorMessage })
      .where(eq(files.id, numericId));
    return apiError(502, INTERNAL_ERROR, "Lambda invocation failed");
  }

  return Response.json({ status: "processing", file_id: numericId });
}
