import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

// Routes whose page bodies must be reachable without a session so that link
// unfurlers (Slack, Notion, etc.) and signed-out humans can read the page
// metadata. The page (or layout) renders a `SignInRequired` CTA in place
// of the real body when there's no session, so no data ever leaks; the
// metadata exports still resolve and produce a useful unfurl.
const publicPrefixes = [
  "/login",
  "/api/auth",
  "/api/v1",
  "/instruments",
  "/settings",
];

// `startsWith("/")` would match every path and short-circuit the guard, so
// the root dashboard needs an exact match.
const publicExactPaths = new Set(["/"]);

export const proxy = auth((req) => {
  const { pathname } = req.nextUrl;

  const isPublic =
    publicExactPaths.has(pathname) ||
    publicPrefixes.some((route) => pathname.startsWith(route));
  if (isPublic) {
    return NextResponse.next();
  }

  if (!req.auth) {
    const loginUrl = new URL("/login", req.url);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|images/).*)"],
};
