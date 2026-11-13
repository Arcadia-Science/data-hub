import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { RAW_PATH_HEADER } from "@/lib/api/run-id-param";
import { REQUEST_PATH_HEADER } from "@/lib/callback-url";
import { config, proxy } from "@/proxy";

const SESSION_COOKIE = "better-auth.session_token=abc.def";

function request(
  path: string,
  init: { cookie?: string; header?: string; rawPathHeader?: string } = {}
) {
  const headers = new Headers();
  if (init.cookie) {
    headers.set("cookie", init.cookie);
  }
  if (init.header) {
    headers.set(REQUEST_PATH_HEADER, init.header);
  }
  if (init.rawPathHeader) {
    headers.set(RAW_PATH_HEADER, init.rawPathHeader);
  }
  return new NextRequest(`http://localhost:3000${path}`, { headers });
}

// `NextResponse.next({ request: { headers } })` exposes the forwarded request
// headers on the response as `x-middleware-request-*` entries.
function forwardedPath(response: Response): string | null {
  return response.headers.get(`x-middleware-request-${REQUEST_PATH_HEADER}`);
}

function forwardedRawPath(response: Response): string | null {
  return response.headers.get(`x-middleware-request-${RAW_PATH_HEADER}`);
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

  it.each([
    "/api/v1/runs",
    "/api/auth/callback/google",
    "/mcp/v1",
    "/.well-known/oauth-authorization-server",
  ])("passes route handler %s through without the address", (path) => {
    const response = proxy(request(path));
    expect(response.status).toBe(200);
    expect(forwardedPath(response)).toBeNull();
  });

  it("replaces a header value planted by the client", () => {
    const response = proxy(
      request("/instruments?x=1", { header: "//evil.example" })
    );
    expect(forwardedPath(response)).toBe("/instruments?x=1");
  });

  describe("raw path header", () => {
    it.each([
      "/api/v1/instruments/x/runs/Q%2541/request-upload-url",
      "/api/v1/runs",
      "/api/auth/callback/google",
      "/mcp/v1",
      "/.well-known/oauth-authorization-server",
      "/api/cron/reprocess-queue",
      "/instruments/x/runs/Q%2541",
      "/settings/tokens",
      "/watchers",
      "/",
    ])("is set on the public path %s without its query", (path) => {
      const response = proxy(request(`${path}?tab=files&q=%2541`));
      expect(response.status).toBe(200);
      expect(forwardedRawPath(response)).toBe(path);
    });

    it("is set for a signed-in visitor on a gated page", () => {
      const response = proxy(
        request("/users/u%2541?tab=x", { cookie: SESSION_COOKIE })
      );
      expect(response.status).toBe(200);
      expect(forwardedRawPath(response)).toBe("/users/u%2541");
    });

    it("keeps each escape exactly as it was sent", () => {
      const path = "/api/v1/instruments/x/runs/a%23b%3Fc%2Fd%20e%25/files";
      expect(forwardedRawPath(proxy(request(path)))).toBe(path);
    });

    it.each([
      "/api/v1/instruments/x/runs/Q%2541/restore",
      "/instruments/x/runs/Q%2541",
      "/settings",
    ])("replaces a value planted by the client on %s", (path) => {
      const response = proxy(
        request(path, {
          rawPathHeader: "/api/v1/instruments/x/runs/someone-else/restore",
        })
      );
      expect(forwardedRawPath(response)).toBe(path);
    });

    it("is not set on a redirect to the sign-in page", () => {
      const response = proxy(request("/comments?from=x"));
      expect(response.status).toBe(307);
      expect(forwardedRawPath(response)).toBeNull();
    });

    it("leaves the other forwarded headers as they were", () => {
      const response = proxy(
        request("/instruments/x/runs/Q%2541", { cookie: SESSION_COOKIE })
      );
      expect(forwardedPath(response)).toBe("/instruments/x/runs/Q%2541");
      expect(response.headers.get("x-middleware-request-cookie")).toBe(
        SESSION_COOKIE
      );
    });
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

describe("proxy matcher", () => {
  function runsProxy(path: string) {
    return unstable_doesMiddlewareMatch({
      config,
      url: `http://localhost:3000${path}`,
    });
  }

  // Next.js cuts a request body at 10 MB when the proxy runs, which breaks
  // the stand-in's 64 MiB upload parts.
  it.each([
    "/api/local-s3/test-raw-data-bucket/inst/run/big.bin",
    "/api/local-s3/test-raw-data-bucket/inst/run/big.bin?uploadId=u&partNumber=1",
  ])("skips the local S3 stand-in at %s", (path) => {
    expect(runsProxy(path)).toBe(false);
  });

  it.each([
    "/",
    "/comments",
    "/instruments/a/runs/b",
    "/instruments/x/runs/Q%2541",
    "/api/v1/runs",
    "/api/v1/instruments/x/runs/y",
    "/api/v1/instruments/x/runs/y/request-upload-url",
    "/api/v1/instruments/x/runs/y/comments",
    "/api/v1/instruments/x/runs/Q%2541/restore",
    "/api/local-s3",
    "/api/local-s3x/b/k",
  ])("runs on %s", (path) => {
    expect(runsProxy(path)).toBe(true);
  });
});
