import { describe, expect, it } from "vitest";
import type { AuthResult } from "@/lib/api/auth";
import {
  decideWatcherBinding,
  isBoundToOtherToken,
  tokenMayChangeInstrumentFiles,
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

describe("tokenMayChangeInstrumentFiles", () => {
  const active = (instrumentId: string) => ({ deletedAt: null, instrumentId });
  const deregistered = (instrumentId: string) => ({
    deletedAt: new Date("2026-11-01T00:00:00Z"),
    instrumentId,
  });

  it("lets a token that registered no watcher change any instrument's files", () => {
    expect(tokenMayChangeInstrumentFiles([], "instr-a")).toBe(true);
  });

  it("lets a watcher's token change its own instrument's files", () => {
    expect(tokenMayChangeInstrumentFiles([active("instr-a")], "instr-a")).toBe(
      true
    );
  });

  it("refuses a watcher's token on another instrument's files", () => {
    expect(tokenMayChangeInstrumentFiles([active("instr-a")], "instr-b")).toBe(
      false
    );
  });

  it("lets one token change the files of each instrument it watches", () => {
    const watchers = [active("instr-a"), active("instr-b")];
    expect(tokenMayChangeInstrumentFiles(watchers, "instr-a")).toBe(true);
    expect(tokenMayChangeInstrumentFiles(watchers, "instr-b")).toBe(true);
    expect(tokenMayChangeInstrumentFiles(watchers, "instr-c")).toBe(false);
  });

  it("refuses a token whose watcher on that instrument was deregistered", () => {
    expect(
      tokenMayChangeInstrumentFiles([deregistered("instr-a")], "instr-a")
    ).toBe(false);
    expect(
      tokenMayChangeInstrumentFiles(
        [deregistered("instr-a"), active("instr-b")],
        "instr-a"
      )
    ).toBe(false);
  });

  it("allows a token that registered the instrument's watcher again", () => {
    expect(
      tokenMayChangeInstrumentFiles(
        [deregistered("instr-a"), active("instr-a")],
        "instr-a"
      )
    ).toBe(true);
  });
});
