import type { NextRequest } from "next/server";
import {
  dispatchQueuedFiles,
  hasStartableQueuedFiles,
  isLambdaConfigured,
  requeueStalledDispatches,
} from "@/lib/api/file-reprocessing";

// Keeps the reprocess queue moving. Every reprocess request and every
// completed or failed file already starts the next queued file. This catches
// what those miss:
//   - A slot freed by a file that stalled. Nothing else triggers a dispatch
//     when the stall window passes.
//   - A file that the dispatcher started and that then stalled, which has no
//     Lambda behind it. It goes back in the queue once, before the dispatch
//     below.
//   - A dispatch that gave up waiting for the dispatch lock, a dispatch that
//     failed, and a file that went back to the queue after the Lambda answered
//     429.
// Triggered by Vercel Cron (`web/vercel.json`), authed via `CRON_SECRET`.

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Without a Lambda to call, nothing can start a queued file. Say so in the
  // log, once per run, so files that sit in the queue do not go unnoticed. They
  // can be cancelled from the run page.
  if (!isLambdaConfigured()) {
    if (await hasStartableQueuedFiles()) {
      console.warn(
        "Files are queued for reprocessing, but the Lambda is not configured (LAMBDA_FUNCTION_URL or the AWS credentials are missing), so nothing can start them."
      );
    }
    return Response.json({ started_files: 0 });
  }

  const requeued = await requeueStalledDispatches();
  if (requeued > 0) {
    console.warn(
      `Put ${requeued} stalled ${requeued === 1 ? "file" : "files"} back in the reprocess queue.`
    );
  }
  const started = await dispatchQueuedFiles();

  return Response.json({ started_files: started.length });
}
