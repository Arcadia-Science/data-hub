import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { REQUEST_PATH_HEADER } from "@/lib/callback-url";
import { proxy } from "@/proxy";

const SESSION_COOKIE = "better-auth.session_token=abc.def";

function request(
  path: string,
  init: { cookie?: string; header?: string } = {}
) {
  const headers = new Headers();
  if (init.cookie) {
    headers.set("cookie", init.cookie);
  }
  if (init.header) {
    headers.set(REQUEST_PATH_HEADER, init.header);
  }
  return new NextRequest(`http://localhost:3000${path}`, { headers });
}

// `NextResponse.next({ request: { headers } })` exposes the forwarded request
// headers on the response as `x-middleware-request-*` entries.
function forwardedPath(response: Response): string | null {
  return response.headers.get(`x-middleware-request-${REQUEST_PATH_HEADER}`);
}

describe("proxy", () => {
  it.each([
    ["/comments?from=x", "/login?callbackURL=%2Fcomments%3Ffrom%3Dx"],
    [
      "/unknown/page?a=1&b=2",
      "/login?callbackURL=%2Funknown%2Fpage%3Fa%3D1%26b%3D2",
    ],
    ["/watchers/abc", "/login?callbackURL=%2Fwatchers%2Fabc"],
    ["/users/u1?tab=x", "/login?callbackURL=%2Fusers%2Fu1%3Ftab%3Dx"],
  ])("redirects a signed-out visitor from %s", (path, location) => {
    const response = proxy(request(path));
    expect(response.status).toBe(307);
    const target = new URL(response.headers.get("location") ?? "");
    expect(`${target.pathname}${target.search}`).toBe(location);
  });

  it.each([
    "/",
    "/?changelog=2026-10-08-entry",
    "/instruments/a/runs/b?tab=files",
    "/settings/tokens",
    "/watchers",
  ])("passes public route %s through with its address", (path) => {
    const response = proxy(request(path));
    expect(response.status).toBe(200);
    expect(forwardedPath(response)).toBe(path);
  });

  it("passes a signed-in visitor through with the address", () => {
    const response = proxy(
      request("/comments?from=x", { cookie: SESSION_COOKIE })
    );
    expect(response.status).toBe(200);
    expect(forwardedPath(response)).toBe("/comments?from=x");
  });

  it("replaces a header value planted by the client", () => {
    const response = proxy(
      request("/instruments?x=1", { header: "//evil.example" })
    );
    expect(forwardedPath(response)).toBe("/instruments?x=1");
  });

  it.each([
    "/login",
    "/api/v1/runs",
    "/mcp",
  ])("does not redirect %s", (path) => {
    const response = proxy(request(path));
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("never redirects /login back to itself", () => {
    const response = proxy(request("/login?callbackURL=%2Fcomments"));
    expect(response.headers.get("location")).toBeNull();
    expect(forwardedPath(response)).toBe("/");
  });
});
