import { describe, expect, it } from "vitest";
import { signInMethod } from "@/lib/analytics/sign-in-method";

describe("signInMethod", () => {
  it("treats the Google callback as a Google sign-in", () => {
    expect(signInMethod("/api/auth/callback/google")).toBe("google");
  });

  it("treats the ID-token social path as a Google sign-in", () => {
    expect(signInMethod("/sign-in/social")).toBe("google");
  });

  it("treats email sign-in as a credential", () => {
    expect(signInMethod("/sign-in/email")).toBe("credential");
  });

  it("falls back when the path is something else", () => {
    expect(signInMethod("/sign-up/email")).toBe("session");
  });
});
