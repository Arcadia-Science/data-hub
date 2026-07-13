import { cookies } from "next/headers";
import { isValidTimeZone, TIMEZONE_COOKIE_NAME } from "@/lib/date";

/**
 * IANA timezone for the current request, from the `timezone` cookie the
 * browser syncs. Falls back to UTC when missing or invalid (first visit,
 * MCP, or a tampered cookie).
 */
export async function getViewerTimeZone(): Promise<string> {
  const value = (await cookies()).get(TIMEZONE_COOKIE_NAME)?.value;
  if (value && isValidTimeZone(value)) {
    return value;
  }
  return "UTC";
}
