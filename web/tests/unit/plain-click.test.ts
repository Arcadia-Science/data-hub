import { describe, expect, it } from "vitest";
import { isPlainLeftClick } from "@/lib/plain-click";

describe("isPlainLeftClick", () => {
  const base = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
  };

  it("accepts an unmodified left click", () => {
    expect(isPlainLeftClick(base)).toBe(true);
  });

  it("rejects a click that another handler already took over", () => {
    expect(isPlainLeftClick({ ...base, defaultPrevented: true })).toBe(false);
  });

  it("rejects modified clicks and non-left buttons", () => {
    expect(isPlainLeftClick({ ...base, metaKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, ctrlKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, shiftKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, altKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...base, button: 1 })).toBe(false);
  });
});
