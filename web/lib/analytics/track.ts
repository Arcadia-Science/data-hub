import { track } from "@vercel/analytics/server";
import { headers } from "next/headers";
import { after } from "next/server";

/**
 * Custom events sent to Vercel Web Analytics. Property values stay flat
 * (string, number, boolean, or null) because nested objects are rejected.
 * Never add names, emails, run ids, filenames, search text, or tool arguments.
 */
export interface AnalyticsEvents {
  admin_role_changed: {
    user_id: string;
    granted: boolean;
  };
  archive_downloaded: SurfaceEvent;
  comment_added: SurfaceEvent;
  comment_deleted: SurfaceEvent;
  comment_edited: SurfaceEvent;
  file_downloaded: SurfaceEvent & { category: string };
  file_reprocessed: SurfaceEvent;
  mcp_connect: {
    user_id: string;
    client: string;
    client_version: string;
  };
  mcp_prompt_get: {
    user_id: string;
    prompt: string;
    client: string;
  };
  mcp_resource_read: {
    user_id: string;
    resource: string;
    client: string;
    outcome: "ok" | "exception";
  };
  mcp_tool_call: {
    user_id: string;
    tool: string;
    client: string;
    outcome: "ok" | "tool_error" | "exception";
    duration_bucket: "under_1s" | "1_to_5s" | "5_to_30s" | "over_30s";
    auth: "oauth" | "pat";
  };
  run_claimed: SurfaceEvent;
  run_deleted: SurfaceEvent;
  run_reprocessed: SurfaceEvent;
  run_restored: SurfaceEvent;
  run_unclaimed: SurfaceEvent;
  search_performed: SurfaceEvent & {
    scope: string;
    result_bucket: "0" | "1_to_10" | "over_10";
  };
  sign_in: {
    user_id: string;
    method: string;
  };
  token_created: { user_id: string };
  token_revoked: { user_id: string };
  web_visit: {
    user_id: string;
    is_admin: boolean;
  };
}

interface SurfaceEvent {
  surface: "web" | "api";
  user_id: string;
}

export type AnalyticsEventName = keyof AnalyticsEvents;

type EventProps<N extends AnalyticsEventName> =
  | AnalyticsEvents[N]
  | (() => AnalyticsEvents[N] | Promise<AnalyticsEvents[N]>);

export function analyticsSurface(
  authMethod: "session" | "token"
): "web" | "api" {
  return authMethod === "session" ? "web" : "api";
}

export function durationBucket(
  elapsedMs: number
): AnalyticsEvents["mcp_tool_call"]["duration_bucket"] {
  if (elapsedMs < 1000) {
    return "under_1s";
  }
  if (elapsedMs < 5000) {
    return "1_to_5s";
  }
  if (elapsedMs < 30_000) {
    return "5_to_30s";
  }
  return "over_30s";
}

export function searchResultBucket(
  total: number
): AnalyticsEvents["search_performed"]["result_bucket"] {
  if (total <= 0) {
    return "0";
  }
  if (total <= 10) {
    return "1_to_10";
  }
  return "over_10";
}

/**
 * Records a custom event. Production sends it after the response so a slow
 * or failed intake cannot change the request. Other environments drop it;
 * local development prints it so the catalog can be checked without Vercel.
 */
export function trackEvent<N extends AnalyticsEventName>(
  name: N,
  props: EventProps<N>
): void {
  if (process.env.VERCEL_ENV !== "production") {
    if (process.env.NODE_ENV === "development") {
      console.debug("[analytics]", name, props);
    }
    return;
  }

  const load = typeof props === "function" ? props : () => props;

  try {
    // Start the headers() read during the request. Next.js 16 throws if it
    // is first called inside `after()` from a Server Component (web_visit).
    const requestHeaders = headers();
    after(async () => {
      try {
        const data = await load();
        await track(
          name,
          data as Record<string, string | number | boolean | null>,
          { headers: await requestHeaders }
        );
      } catch (error) {
        console.error("[analytics] failed to send event", name, error);
      }
    });
  } catch (error) {
    console.error("[analytics] failed to schedule event", name, error);
  }
}
