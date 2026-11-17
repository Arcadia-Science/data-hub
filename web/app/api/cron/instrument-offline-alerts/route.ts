import type { NextRequest } from "next/server";
import { runInstrumentOfflineAlerts } from "@/lib/api/instrument-offline-alerts";

// Tells an instrument's subscribers when its badge has been Offline for 30
// minutes, and again when it's back Online. See
// `lib/api/instrument-offline-alerts.ts` for the job and
// `lib/instruments/offline-alerts.ts` for the rules.
// Triggered by Vercel Cron (`web/vercel.json`), authed via `CRON_SECRET`.

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  return Response.json(await runInstrumentOfflineAlerts());
}
