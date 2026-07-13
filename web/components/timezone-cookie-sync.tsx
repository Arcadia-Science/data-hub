"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  getBrowserTimeZone,
  TIMEZONE_COOKIE_MAX_AGE,
  TIMEZONE_COOKIE_NAME,
} from "@/lib/date";

function readTimezoneCookie(): string | undefined {
  const match = document.cookie.match(
    new RegExp(`(?:^|; )${TIMEZONE_COOKIE_NAME}=([^;]*)`)
  );
  return match ? decodeURIComponent(match[1] ?? "") : undefined;
}

/**
 * Persists the browser IANA timezone in a cookie so RSC stats can compute
 * calendar day/week boundaries. Refreshes once when the cookie was missing or
 * out of date so the first paint after sync uses the real zone.
 */
export function TimezoneCookieSync() {
  const router = useRouter();

  useEffect(() => {
    const browserTz = getBrowserTimeZone();
    const current = readTimezoneCookie();
    if (current === browserTz) {
      return;
    }
    // Same document.cookie pattern as the sidebar open-state cookie: must be
    // JS-writable so RSC can read it on the next request via `cookies()`.
    // biome-ignore lint/suspicious/noDocumentCookie: intentional client cookie write for SSR timezone
    document.cookie = `${TIMEZONE_COOKIE_NAME}=${encodeURIComponent(browserTz)}; path=/; max-age=${TIMEZONE_COOKIE_MAX_AGE}; samesite=lax`;
    router.refresh();
  }, [router]);

  return null;
}
