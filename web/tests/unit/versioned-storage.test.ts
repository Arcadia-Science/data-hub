import { describe, expect, it } from "vitest";
import {
  parsePersistedFileId,
  serializePersistedFileId,
} from "@/lib/runs/persisted-file-id";
import { parseVersioned, serializeVersioned } from "@/lib/versioned-storage";

describe("versioned list storage", () => {
  it("reads back what it wrote", () => {
    const saved = serializeVersioned(["a", "b"]);
    expect(parseVersioned(saved)).toEqual(["a", "b"]);
  });

  it("still reads a list saved before versions existed", () => {
    expect(parseVersioned(JSON.stringify(["old", "list"]))).toEqual([
      "old",
      "list",
    ]);
  });

  it("ignores a version it does not know", () => {
    expect(
      parseVersioned(JSON.stringify({ v: 99, data: ["from the future"] }))
    ).toBeUndefined();
  });

  it("ignores missing, broken, and unrelated values", () => {
    expect(parseVersioned(null)).toBeUndefined();
    expect(parseVersioned("")).toBeUndefined();
    expect(parseVersioned("not json")).toBeUndefined();
    expect(
      parseVersioned(JSON.stringify({ something: "else" }))
    ).toBeUndefined();
    expect(parseVersioned("42")).toBeUndefined();
  });
});

describe("persisted file id", () => {
  it("reads back what it wrote", () => {
    expect(parsePersistedFileId(serializePersistedFileId(12))).toBe(12);
  });

  it("still reads a value saved before versions existed", () => {
    expect(parsePersistedFileId(JSON.stringify({ fileId: 7 }))).toBe(7);
  });

  it("ignores a version it does not know and bad values", () => {
    expect(
      parsePersistedFileId(JSON.stringify({ v: 2, fileId: 7 }))
    ).toBeUndefined();
    expect(
      parsePersistedFileId(JSON.stringify({ fileId: "7" }))
    ).toBeUndefined();
    expect(parsePersistedFileId(null)).toBeUndefined();
    expect(parsePersistedFileId("nope")).toBeUndefined();
  });
});
