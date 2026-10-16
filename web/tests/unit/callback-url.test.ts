import { describe, expect, it } from "vitest";
import {
  loginHref,
  loginPageCallbackPath,
  safeCallbackPath,
  signInErrorPath,
} from "@/lib/callback-url";

describe("safeCallbackPath", () => {
  it.each([
    "/",
    "/comments?from=2026-10-01",
    "/instruments/abc/runs/x%2Fy?tab=files",
    "/?changelog=2026-10-08-some-entry",
    "/settings/tokens",
  ])("accepts %s", (path) => {
    expect(safeCallbackPath(path)).toBe(path);
  });

  it.each([
    "//evil.example",
    "/.//evil.example",
    "/a/..//evil.example",
    "/\\evil.example",
    "/a\\b?x=1",
    "\\\\evil.example",
    "https://evil.example",
    "javascript:alert(1)",
    "evil.example",
    "/%0d%0aevil",
    "/a\tb",
    "/a\nb",
    "/a\u0000b",
    "/a\u007fb",
    "",
    "/login",
    "/login?x=1",
    "/login/extra",
    "/a/../login",
    "/%zz",
  ])("falls back to / for %j", (value) => {
    expect(safeCallbackPath(value)).toBe("/");
  });

  it.each([
    undefined,
    null,
    5,
    {},
    ["/a"],
  ])("falls back to / for non-string %j", (value) => {
    expect(safeCallbackPath(value)).toBe("/");
  });

  it("removes _rsc and error but keeps the other parameters in order", () => {
    expect(safeCallbackPath("/runs?b=2&_rsc=abc&a=1&error=google")).toBe(
      "/runs?b=2&a=1"
    );
    expect(safeCallbackPath("/runs?_rsc=abc&error=x")).toBe("/runs");
    expect(
      safeCallbackPath(
        "/runs?tab=files&error=access_denied&error_description=x"
      )
    ).toBe("/runs?tab=files");
  });

  it.each([
    "/runs?q=100%",
    "/runs?q=a%0Ab",
  ])("keeps the path and query of %s", (path) => {
    expect(safeCallbackPath(path)).toBe(path);
  });

  it.each([
    ["/?status=failed,stalled", "/?status=failed%2Cstalled"],
    ["/?search=C:\\data\\run1", "/?search=C%3A%5Cdata%5Crun1"],
    ["/runs/a?temp=20|30&tab=files", "/runs/a?temp=20%7C30&tab=files"],
    ["/runs?q=a~b!c*(d)", "/runs?q=a%7Eb%21c%2A%28d%29"],
  ])("percent-encodes the query of %s", (path, expected) => {
    expect(safeCallbackPath(path)).toBe(expected);
  });

  // Better Auth's relative-path rule, which its `oAuthProxy` callback applies
  // to the return address on preview deployments. It also rejects `%` in the
  // path, which this helper can't avoid.
  const betterAuthRelativePath =
    /^\/(?!\/|\\|%2f|%5c)[\w\-.+/@]*(?:\?[\w\-.+/=&%@]*)?$/;

  it.each([
    "/comments?from=2026-10-01",
    "/?changelog=2026-10-08-some-entry",
    "/?status=failed,stalled&instrument_id=a,b",
    "/?search=C:\\data\\run1",
    "/runs/a?temp=20|30&tab=files",
    "/runs?q=a b&r=\"x\"&s=<y>&t='z'&u=a?b",
    "/runs?q=café",
  ])("returns an address Better Auth accepts, with the same query, for %j", (path) => {
    const safe = safeCallbackPath(path);
    expect(safe).toMatch(betterAuthRelativePath);
    expect([...new URL(safe, "http://x.test").searchParams]).toEqual([
      ...new URL(path, "http://x.test").searchParams,
    ]);
  });
});

describe("loginPageCallbackPath", () => {
  it("uses a checked callbackURL", () => {
    expect(loginPageCallbackPath({ callbackURL: "/comments?from=x" })).toBe(
      "/comments?from=x"
    );
    expect(loginPageCallbackPath({ callbackURL: "//evil.example" })).toBe("/");
    expect(loginPageCallbackPath({ callbackURL: ["/a", "/b"] })).toBe("/");
    expect(loginPageCallbackPath({})).toBe("/");
  });

  it("ignores callbackURL during an MCP OAuth sign-in", () => {
    expect(
      loginPageCallbackPath({ client_id: "x", callbackURL: "/comments" })
    ).toBe("/");
  });
});

describe("loginHref", () => {
  it("returns bare /login for the home page and unsafe values", () => {
    expect(loginHref("/")).toBe("/login");
    expect(loginHref("//evil.example")).toBe("/login");
  });

  it("encodes the path and query", () => {
    expect(loginHref("/comments?from=x")).toBe(
      "/login?callbackURL=%2Fcomments%3Ffrom%3Dx"
    );
  });
});

describe("signInErrorPath", () => {
  it("keeps the return address on the login page", () => {
    expect(signInErrorPath("/comments?from=x", true)).toBe(
      "/login?callbackURL=%2Fcomments%3Ffrom%3Dx"
    );
    expect(signInErrorPath("/", true)).toBe("/login");
  });

  it("returns an in-page box to its own address", () => {
    expect(signInErrorPath("/runs/a?tab=files", false)).toBe(
      "/runs/a?tab=files"
    );
    expect(signInErrorPath("/", false)).toBe("/");
  });
});
