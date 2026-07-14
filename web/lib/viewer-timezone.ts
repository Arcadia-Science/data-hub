import { cookies, headers } from "next/headers";
import { cache } from "react";
import { isValidTimeZone, TIMEZONE_COOKIE_NAME } from "@/lib/date";

/**
 * IANA timezone for the current request.
 *
 * Prefer the `timezone` cookie the browser syncs. When it is missing (first
 * visit, MCP, cron), fall back to Vercel's `x-vercel-ip-timezone` so calendar
 * windows are usually correct without a UTC first paint + `router.refresh()`.
 * Last resort is UTC.
 */
export const getViewerTimeZone = cache(
  async function getViewerTimeZone(): Promise<string> {
    const value = (await cookies()).get(TIMEZONE_COOKIE_NAME)?.value;
    if (value && isValidTimeZone(value)) {
      return value;
    }
    const ipTz = (await headers()).get("x-vercel-ip-timezone");
    if (ipTz && isValidTimeZone(ipTz)) {
      return ipTz;
    }
    return "UTC";
  }
);
