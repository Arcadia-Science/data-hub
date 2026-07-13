"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  getBrowserTimeZone,
  TIMEZONE_COOKIE_MAX_AGE,
  TIMEZONE_COOKIE_NAME,
} from "@/lib/date";

const TIMEZONE_COOKIE_RE = new RegExp(
  `(?:^|; )${TIMEZONE_COOKIE_NAME}=([^;]*)`
);

function readTimezoneCookie(): string | undefined {
  const match = document.cookie.match(TIMEZONE_COOKIE_RE);
  return match ? decodeURIComponent(match[1] ?? "") : undefined;
}

/**
 * Persists the browser IANA timezone in a cookie so RSC stats can compute
 * calendar day/week boundaries. Refreshes only when the server rendered with
 * a different zone (missing cookie + UTC, or IP guess ≠ browser) so the next
 * paint matches local midnight — skipped when the cookie or IP fallback already
 * agreed with the client.
 */
export function TimezoneCookieSync({
  serverTimeZone,
}: {
  serverTimeZone: string;
}) {
  const router = useRouter();

  useEffect(() => {
    const browserTz = getBrowserTimeZone();
    const current = readTimezoneCookie();
    if (current !== browserTz) {
      // Same document.cookie pattern as the sidebar open-state cookie: must be
      // JS-writable so RSC can read it on the next request via `cookies()`.
      // biome-ignore lint/suspicious/noDocumentCookie: intentional client cookie write for SSR timezone
      document.cookie = `${TIMEZONE_COOKIE_NAME}=${encodeURIComponent(browserTz)}; path=/; max-age=${TIMEZONE_COOKIE_MAX_AGE}; samesite=lax`;
    }
    if (serverTimeZone !== browserTz) {
      router.refresh();
    }
  }, [router, serverTimeZone]);

  return null;
}
