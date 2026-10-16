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
    "/\\evil.example",
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

  it("returns to the page itself from an in-page box, except on /", () => {
    expect(signInErrorPath("/runs/a?tab=files", false)).toBe(
      "/runs/a?tab=files"
    );
    expect(signInErrorPath("/", false)).toBe("/login");
  });
});
