import { describe, expect, it } from "vitest";
import { buildPageHref } from "@/lib/pagination";

describe("buildPageHref", () => {
  it("sets the page param and keeps the other filters", () => {
    expect(
      buildPageHref("/instruments/gel-1", "search=abc&sort=-created", "page", 3)
    ).toBe("/instruments/gel-1?search=abc&sort=-created&page=3");
  });

  it("replaces an existing page param instead of adding a second one", () => {
    expect(buildPageHref("/", "page=2&search=abc", "page", 5)).toBe(
      "/?page=5&search=abc"
    );
  });

  it("drops the param for page 1 so the first page has a clean URL", () => {
    expect(buildPageHref("/", "page=4", "page", 1)).toBe("/");
    expect(buildPageHref("/", "page=4&search=abc", "page", 1)).toBe(
      "/?search=abc"
    );
  });

  it("treats pages below 1 as page 1", () => {
    expect(buildPageHref("/", "page=1", "page", 0)).toBe("/");
    expect(buildPageHref("/", "page=1", "page", -2)).toBe("/");
  });

  it("only changes the named param when a page has several lists", () => {
    expect(
      buildPageHref("/watchers/w1", "logs_page=2&files_page=4", "logs_page", 3)
    ).toBe("/watchers/w1?logs_page=3&files_page=4");
  });

  it("accepts URLSearchParams as well as a string", () => {
    const params = new URLSearchParams("a=1");
    expect(buildPageHref("/x", params, "page", 2)).toBe("/x?a=1&page=2");
    // The caller's object stays untouched.
    expect(params.toString()).toBe("a=1");
  });
});
