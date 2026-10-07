import { afterEach, describe, expect, it, vi } from "vitest";
import { nextPlain, nextSecret } from "@/lib/integrations/config-patch";
import {
  plainFieldStatus,
  resolveIntegrationField,
  savedPlainValue,
  secretFieldStatus,
} from "@/lib/integrations/field-status";
import {
  lastUpdatedResponse,
  toLastUpdated,
} from "@/lib/integrations/last-updated";

const readable = (value: string) => ({ state: "readable", value }) as const;
const empty = { state: "empty" } as const;
const unreadable = { state: "unreadable" } as const;

describe("resolveIntegrationField", () => {
  it("prefers a saved value over the environment variable", () => {
    expect(resolveIntegrationField(readable("from-db"), "from-env")).toEqual({
      value: "from-db",
      source: "database",
    });
  });

  it("uses the environment variable when nothing is saved", () => {
    expect(resolveIntegrationField(empty, "from-env")).toEqual({
      value: "from-env",
      source: "environment",
    });
    expect(resolveIntegrationField(savedPlainValue("  "), "from-env")).toEqual({
      value: "from-env",
      source: "environment",
    });
  });

  it("is unset when neither source has a value", () => {
    expect(resolveIntegrationField(empty, undefined)).toEqual({
      value: null,
      source: null,
    });
    expect(resolveIntegrationField(empty, "  ")).toEqual({
      value: null,
      source: null,
    });
  });

  it("flags an unreadable saved value and keeps using the environment variable", () => {
    const resolved = resolveIntegrationField(unreadable, "from-env");
    expect(resolved).toEqual({ value: "from-env", source: "unreadable" });
    expect(secretFieldStatus(resolved)).toEqual({
      set: true,
      source: "unreadable",
    });
  });

  it("reports an unreadable saved value as not set when there is no fallback", () => {
    const resolved = resolveIntegrationField(unreadable, undefined);
    expect(secretFieldStatus(resolved)).toEqual({
      set: false,
      source: "unreadable",
    });
    expect(plainFieldStatus(resolved).value).toBeNull();
  });
});

describe("integration patches", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps, clears, or replaces a plain value", () => {
    expect(nextPlain("kept", undefined)).toBe("kept");
    expect(nextPlain("old", null)).toBeNull();
    expect(nextPlain("old", "new")).toBe("new");
  });

  it("keeps, clears, or encrypts a secret", () => {
    vi.stubEnv("INTEGRATION_SECRETS_KEY", "ab".repeat(32));
    expect(nextSecret("v1:kept", undefined)).toBe("v1:kept");
    expect(nextSecret("v1:old", null)).toBeNull();
    const replaced = nextSecret("v1:old", "plain-secret");
    expect(replaced?.startsWith("v1:")).toBe(true);
    expect(replaced).not.toContain("plain-secret");
  });
});

describe("last updated", () => {
  it("is null until a row has been saved", () => {
    expect(toLastUpdated(null)).toBeNull();
    expect(
      toLastUpdated({
        updatedAt: null,
        updatedById: null,
        updatedByName: null,
        updatedByEmail: null,
      })
    ).toBeNull();
    expect(lastUpdatedResponse(null)).toEqual({
      updated_at: null,
      updated_by: null,
    });
  });

  it("serializes the time and the person who saved", () => {
    const lastUpdated = toLastUpdated({
      updatedAt: new Date("2026-10-06T12:00:00.000Z"),
      updatedById: "user-1",
      updatedByName: "Ada",
      updatedByEmail: "ada@example.com",
    });
    expect(lastUpdated).toEqual({
      at: "2026-10-06T12:00:00.000Z",
      byId: "user-1",
      byName: "Ada",
      byEmail: "ada@example.com",
    });
    expect(lastUpdatedResponse(lastUpdated)).toEqual({
      updated_at: "2026-10-06T12:00:00.000Z",
      updated_by: { id: "user-1", name: "Ada", email: "ada@example.com" },
    });
  });

  it("omits the person when the user was deleted", () => {
    const lastUpdated = toLastUpdated({
      updatedAt: new Date("2026-10-06T12:00:00.000Z"),
      updatedById: null,
      updatedByName: null,
      updatedByEmail: null,
    });
    expect(lastUpdatedResponse(lastUpdated).updated_by).toBeNull();
  });
});
