import { describe, expect, it } from "vitest";
import type { AuthResult } from "@/lib/api/auth";
import { SCOPE_PRESETS } from "@/lib/api/scope-catalog";
import { ALL_SCOPES, hasScope } from "@/lib/api/scopes";
import {
  decideWatcherBinding,
  hasLegacyScope,
  isBoundToOtherToken,
  narrowWatcherTokenScopes,
  tokenMayActOnInstrument,
  tokenMayAdminister,
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
    userId: null,
    authMethod: "token",
    scopes: ["watchers:report"],
    tokenId,
    tokenName: "watcher-pc",
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

  it("denies token auth with an empty tokenId", () => {
    expect(decideWatcherBinding(tokenAuth(""), "pat-a")).toBe("deny");
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

  it("is false for token auth with an empty tokenId", () => {
    expect(isBoundToOtherToken(tokenAuth(""), "pat-b")).toBe(false);
  });
});

describe("tokenMayActOnInstrument", () => {
  const active = (instrumentId: string) => ({ deletedAt: null, instrumentId });
  const deregistered = (instrumentId: string) => ({
    deletedAt: new Date("2026-11-01T00:00:00Z"),
    instrumentId,
  });

  it("lets a token that registered no watcher write to any instrument", () => {
    expect(tokenMayActOnInstrument([], "instr-a")).toBe(true);
  });

  it("lets a watcher's token write to its own instrument", () => {
    expect(tokenMayActOnInstrument([active("instr-a")], "instr-a")).toBe(true);
  });

  it("refuses a watcher's token on another instrument", () => {
    expect(tokenMayActOnInstrument([active("instr-a")], "instr-b")).toBe(false);
  });

  it("lets one token write to each instrument it watches", () => {
    const watchers = [active("instr-a"), active("instr-b")];
    expect(tokenMayActOnInstrument(watchers, "instr-a")).toBe(true);
    expect(tokenMayActOnInstrument(watchers, "instr-b")).toBe(true);
    expect(tokenMayActOnInstrument(watchers, "instr-c")).toBe(false);
  });

  it("refuses a token whose watcher on that instrument was deregistered", () => {
    expect(tokenMayActOnInstrument([deregistered("instr-a")], "instr-a")).toBe(
      false
    );
    expect(
      tokenMayActOnInstrument(
        [deregistered("instr-a"), active("instr-b")],
        "instr-a"
      )
    ).toBe(false);
  });

  it("allows a token that registered the instrument's watcher again", () => {
    expect(
      tokenMayActOnInstrument(
        [deregistered("instr-a"), active("instr-a")],
        "instr-a"
      )
    ).toBe(true);
  });
});

describe("tokenMayAdminister", () => {
  it("lets a token that registered no watcher do admin work", () => {
    expect(tokenMayAdminister([])).toBe(true);
  });

  it("refuses a watcher's token, even for its own instrument", () => {
    expect(
      tokenMayAdminister([{ deletedAt: null, instrumentId: "instr-a" }])
    ).toBe(false);
  });

  it("refuses a token whose watchers were all deregistered", () => {
    expect(
      tokenMayAdminister([
        {
          deletedAt: new Date("2026-11-01T00:00:00Z"),
          instrumentId: "instr-a",
        },
      ])
    ).toBe(false);
  });
});

describe("hasLegacyScope", () => {
  it("finds the wildcard and the coarse :write scopes", () => {
    expect(hasLegacyScope(["*"])).toBe(true);
    expect(hasLegacyScope(["instruments:read", "runs:write"])).toBe(true);
    expect(hasLegacyScope(["files:write"])).toBe(true);
    expect(hasLegacyScope(["watchers:write"])).toBe(true);
  });

  it("ignores fine-grained scopes and object built-ins", () => {
    expect(hasLegacyScope([])).toBe(false);
    expect(hasLegacyScope(["runs:read", "watchers:report"])).toBe(false);
    expect(hasLegacyScope(["constructor", "toString"])).toBe(false);
  });
});

describe("narrowWatcherTokenScopes", () => {
  const watcherPreset =
    SCOPE_PRESETS.find((preset) => preset.id === "watcher")?.scopes ?? [];

  it("turns the wildcard into the Watcher preset", () => {
    expect(watcherPreset.length).toBeGreaterThan(0);
    expect([...narrowWatcherTokenScopes(["*"])].sort()).toEqual(
      [...watcherPreset].sort()
    );
  });

  it("drops read access to other instruments' runs and files", () => {
    const narrowed = { scopes: narrowWatcherTokenScopes(["*"]) };
    expect(hasScope(narrowed, "runs:read")).toBe(false);
    expect(hasScope(narrowed, "files:read")).toBe(false);
    expect(hasScope(narrowed, "archive-jobs:read")).toBe(false);
    expect(hasScope(narrowed, "watchers:report")).toBe(true);
  });

  it("keeps only the watcher's part of each coarse :write scope", () => {
    expect(
      narrowWatcherTokenScopes([
        "instruments:read",
        "runs:write",
        "files:write",
        "watchers:write",
      ])
    ).toEqual([
      "instruments:read",
      "runs:create",
      "runs:update",
      "runs:upload",
      "files:update",
      "watchers:report",
    ]);
  });

  it("keeps scopes the token lists explicitly", () => {
    expect(narrowWatcherTokenScopes(["runs:read", "watchers:write"])).toEqual([
      "runs:read",
      "watchers:report",
    ]);
    expect(narrowWatcherTokenScopes(["no-longer-a-scope", "*"])).toEqual([
      ...ALL_SCOPES.filter((scope) => watcherPreset.includes(scope)),
      "no-longer-a-scope",
    ]);
  });

  it("leaves a token without legacy scopes as it was", () => {
    expect(narrowWatcherTokenScopes(watcherPreset)).toEqual(
      ALL_SCOPES.filter((scope) => watcherPreset.includes(scope))
    );
    expect(narrowWatcherTokenScopes([])).toEqual([]);
  });

  it("never allows a scope the stored scopes didn't", () => {
    const inputs = [
      ["*"],
      ["runs:write"],
      ["files:write", "instruments:read"],
      ["watchers:write", "runs:read"],
      ["*", "runs:write", "files:write", "watchers:write"],
    ];
    for (const scopes of inputs) {
      const narrowed = { scopes: narrowWatcherTokenScopes(scopes) };
      for (const scope of ALL_SCOPES) {
        if (hasScope(narrowed, scope)) {
          expect(hasScope({ scopes }, scope), `${scopes} → ${scope}`).toBe(
            true
          );
        }
      }
    }
  });
});
