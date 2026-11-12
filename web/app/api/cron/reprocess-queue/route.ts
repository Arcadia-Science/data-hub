import type { NextRequest } from "next/server";
import { dispatchQueuedFiles } from "@/lib/api/file-reprocessing";

// Starts queued reprocessing files once there is room under the processing
// limit. Every reprocess request and every completed or failed file already
// starts the next queued file. This catches what those miss: a slot freed by a
// file that stalled (nothing else triggers a dispatch when the stall window
// passes), a dispatch that gave up waiting for the dispatch lock, a dispatch
// that failed, and a file that went back to the queue after the Lambda
// answered 429. Triggered by Vercel Cron (`web/vercel.json`), authed via
// `CRON_SECRET`.

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const started = await dispatchQueuedFiles();

  return Response.json({ started_files: started.length });
}
