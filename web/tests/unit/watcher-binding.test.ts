import { describe, expect, it } from "vitest";
import type { AuthResult } from "@/lib/api/auth";
import {
  decideWatcherBinding,
  isBoundToOtherToken,
} from "@/lib/api/watcher-binding";

// Pure decision coverage for watcher↔PAT binding. Imports the DB-free
// helper directly so the unit suite never loads `@/lib/db`. The TOFU claim
// path and HTTP 403/200 behaviour live in the integration suite (which has
// no session cookies).

function sessionAuth(): AuthResult {
  return {
    userId: "session-user",
    authMethod: "session",
    scopes: ["*"],
    tokenId: null,
  };
}

function tokenAuth(tokenId: string): AuthResult {
  return {
    userId: "token-user",
    authMethod: "token",
    scopes: ["watchers:report"],
    tokenId,
  };
}

describe("decideWatcherBinding", () => {
  it("denies browser sessions regardless of binding", () => {
    expect(decideWatcherBinding(sessionAuth(), null)).toBe("deny");
    expect(decideWatcherBinding(sessionAuth(), "some-pat-id")).toBe("deny");
  });

  it("allows a token that matches the registered PAT", () => {
    expect(decideWatcherBinding(tokenAuth("pat-a"), "pat-a")).toBe("allow");
  });

  it("denies a token that does not match the registered PAT", () => {
    expect(decideWatcherBinding(tokenAuth("pat-a"), "pat-b")).toBe("deny");
  });

  it("denies token auth with a missing tokenId", () => {
    const broken: AuthResult = {
      userId: "token-user",
      authMethod: "token",
      scopes: ["watchers:report"],
      tokenId: null,
    };
    expect(decideWatcherBinding(broken, "pat-a")).toBe("deny");
  });

  it("returns tofu when the binding is still null", () => {
    expect(decideWatcherBinding(tokenAuth("pat-a"), null)).toBe("tofu");
  });
});

describe("isBoundToOtherToken", () => {
  it("is true for a token meeting a watcher bound to another token", () => {
    expect(isBoundToOtherToken(tokenAuth("pat-a"), "pat-b")).toBe(true);
  });

  it("is false for the bound token and for an unbound watcher", () => {
    expect(isBoundToOtherToken(tokenAuth("pat-a"), "pat-a")).toBe(false);
    expect(isBoundToOtherToken(tokenAuth("pat-a"), null)).toBe(false);
  });

  it("is false for sessions", () => {
    expect(isBoundToOtherToken(sessionAuth(), "pat-b")).toBe(false);
  });

  it("is false for token auth with a missing tokenId", () => {
    const broken: AuthResult = {
      userId: "token-user",
      authMethod: "token",
      scopes: ["watchers:report"],
      tokenId: null,
    };
    expect(isBoundToOtherToken(broken, "pat-b")).toBe(false);
  });
});
