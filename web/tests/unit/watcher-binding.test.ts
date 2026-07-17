import { describe, expect, it } from "vitest";
import type { AuthResult } from "@/lib/api/auth";
import { decideWatcherBinding } from "@/lib/api/watcher-binding";

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
  it("allows browser sessions regardless of binding", () => {
    expect(decideWatcherBinding(sessionAuth(), null)).toBe("allow");
    expect(decideWatcherBinding(sessionAuth(), "some-pat-id")).toBe("allow");
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
