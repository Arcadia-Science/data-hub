// Return-address handling for sign-in. No Node-only imports: `proxy.ts` uses
// this too, and every place that reads a return address must go through
// `safeCallbackPath` so the value can never leave this site.

export const REQUEST_PATH_HEADER = "x-data-hub-request-path";

export const PLACEHOLDER_ORIGIN = "http://callback.invalid";
const LOGIN_PATH = "/login";

// `_rsc` is Next's internal navigation parameter. `error` and Better Auth's
// `error_description` are dropped so a retried sign-in doesn't land on a page
// that still shows the old error.
const DROPPED_QUERY_PARAMS = new Set(["_rsc", "error", "error_description"]);

// On preview deployments, Better Auth's `oAuthProxy` callback rejects a return
// address whose query has any other character, and nuqs writes list filters
// with raw commas, so everything else is percent-encoded.
const BETTER_AUTH_REJECTED_QUERY_CHARACTER = /[^\w\-.+/=&%@]/g;

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) {
      return true;
    }
  }
  return false;
}

// `URL` has already percent-encoded every non-ASCII character in the query,
// so each character left to encode is a single byte.
function percentEncodeByte(char: string): string {
  const hex = char.charCodeAt(0).toString(16).toUpperCase();
  return `%${hex.padStart(2, "0")}`;
}

function queryParamName(part: string): string {
  const raw = part.split("=")[0] ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function returnAddressQuery(search: string): string {
  if (!search) {
    return "";
  }
  const kept = search
    .slice(1)
    .split("&")
    .filter((part) => part && !DROPPED_QUERY_PARAMS.has(queryParamName(part)));
  if (kept.length === 0) {
    return "";
  }
  const query = kept
    .join("&")
    .replace(BETTER_AUTH_REJECTED_QUERY_CHARACTER, percentEncodeByte);
  return `?${query}`;
}

/**
 * Returns `value` (path and query) only when it is a path on this site, and
 * `"/"` otherwise. Never returns the sign-in page, so sign-in can't loop.
 */
export function safeCallbackPath(value: unknown): string {
  if (typeof value !== "string" || value === "") {
    return "/";
  }
  // Browsers read `\` as `/` in a path, but a backslash in the query is plain
  // text that gets percent-encoded below.
  const rawPath = value.split(/[?#]/, 1)[0] ?? "";
  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    rawPath.includes("\\") ||
    hasControlCharacter(value)
  ) {
    return "/";
  }

  let url: URL;
  try {
    url = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return "/";
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) {
    return "/";
  }

  // Only the path is decoded: the query stays percent-encoded in the
  // redirect, so encoded control characters or a stray `%` there are harmless.
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return "/";
  }
  if (hasControlCharacter(decodedPath)) {
    return "/";
  }
  if (
    url.pathname === LOGIN_PATH ||
    url.pathname.startsWith(`${LOGIN_PATH}/`)
  ) {
    return "/";
  }
  // Dot segments can collapse into a leading `//`, as in `/.//evil.example`,
  // which a browser reads as another site.
  if (url.pathname.startsWith("//")) {
    return "/";
  }

  return `${url.pathname}${returnAddressQuery(url.search)}`;
}

/**
 * Return address for the `/login` page. MCP OAuth sign-ins resume through the
 * signed `client_id` query, so `callbackURL` must not compete with it.
 */
export function loginPageCallbackPath(
  params: Record<string, string | string[] | undefined>
): string {
  return params.client_id ? "/" : safeCallbackPath(params.callbackURL);
}

export function loginHref(path: unknown): string {
  const safe = safeCallbackPath(path);
  if (safe === "/") {
    return LOGIN_PATH;
  }
  return `${LOGIN_PATH}?callbackURL=${encodeURIComponent(safe)}`;
}

// Where a failed sign-in goes, before the error code is added. `/login` has to
// carry the return address forward; an in-page sign-in box is already on it.
export function signInErrorPath(
  callbackUrl: unknown,
  fromLoginPage: boolean
): string {
  const safe = safeCallbackPath(callbackUrl);
  return fromLoginPage ? loginHref(safe) : safe;
}
