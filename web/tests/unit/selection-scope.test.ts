import { describe, expect, it } from "vitest";
import {
  isFilesScopeParam,
  isRunListScopeParam,
  selectionScopeKey,
} from "@/lib/selection-scope";

describe("run list selection scope", () => {
  const key = (query: string) => selectionScopeKey(query, isRunListScopeParam);

  it("stays the same when only the page changes", () => {
    expect(key("search=abc")).toBe(key("search=abc&page=3"));
    expect(key("")).toBe(key("page=2&per_page=50"));
  });

  it("changes when a search, filter, or sort changes", () => {
    expect(key("search=abc")).not.toBe(key("search=abd"));
    expect(key("")).not.toBe(key("status=failed"));
    expect(key("")).not.toBe(key("date_from=2026-10-01"));
    expect(key("")).not.toBe(key("ran_by=u1"));
    expect(key("")).not.toBe(key("sort=updated_at"));
    expect(key("")).not.toBe(key("order=asc"));
    expect(key("")).not.toBe(key("include_deleted=true"));
  });

  it("ignores the comments preview on the dashboard", () => {
    expect(key("search=abc")).toBe(
      key("search=abc&comments_from=2026-10-01&comments_to=2026-10-02")
    );
  });

  it("does not depend on the order of params", () => {
    expect(key("a=1&b=2")).toBe(key("b=2&a=1"));
    expect(key("a=1&a=2")).toBe(key("a=2&a=1"));
  });
});

describe("files selection scope", () => {
  const key = (query: string) => selectionScopeKey(query, isFilesScopeParam);

  it("stays the same when only the files page changes", () => {
    expect(key("files_search=x")).toBe(key("files_search=x&files_page=4"));
  });

  it("changes when the files search, filters, or sort change", () => {
    expect(key("")).not.toBe(key("files_search=x"));
    expect(key("")).not.toBe(key("files_status=failed"));
    expect(key("")).not.toBe(key("files_category=raw"));
    expect(key("")).not.toBe(key("files_sort=size"));
    expect(key("")).not.toBe(key("files_dismissed=true"));
  });

  it("ignores params that are not about the files table", () => {
    expect(key("files_search=x")).toBe(key("files_search=x&tab=comments"));
  });
});
