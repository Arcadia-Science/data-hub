import { describe, expect, it } from "vitest";
import {
  isSidebarGroupOpen,
  SIDEBAR_COOKIE_NAME,
  SIDEBAR_INSTRUMENTS_COOKIE_NAME,
  SIDEBAR_NOTEBOOKS_COOKIE_NAME,
} from "@/lib/sidebar-persistence";

describe("isSidebarGroupOpen", () => {
  it("is open when there is no cookie, as on a first visit", () => {
    expect(isSidebarGroupOpen(undefined)).toBe(true);
  });

  it("is open for the value written when the group opens", () => {
    expect(isSidebarGroupOpen("true")).toBe(true);
  });

  it("is closed only for the value written when the group closes", () => {
    expect(isSidebarGroupOpen("false")).toBe(false);
  });

  it("is open for any other value, such as an empty or stale one", () => {
    expect(isSidebarGroupOpen("")).toBe(true);
    expect(isSidebarGroupOpen("0")).toBe(true);
    expect(isSidebarGroupOpen("FALSE")).toBe(true);
  });
});

describe("sidebar cookie names", () => {
  it("gives each group its own cookie, apart from the sidebar's", () => {
    const names = [
      SIDEBAR_COOKIE_NAME,
      SIDEBAR_INSTRUMENTS_COOKIE_NAME,
      SIDEBAR_NOTEBOOKS_COOKIE_NAME,
    ];
    expect(new Set(names).size).toBe(names.length);
  });
});
