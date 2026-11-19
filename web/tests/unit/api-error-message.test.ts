import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { apiErrorMessage } from "@/lib/api/errors";

describe("apiErrorMessage", () => {
  const FALLBACK = "Failed to save";

  it("reads the message from the API's error object", () => {
    expect(
      apiErrorMessage(
        { error: { code: "FORBIDDEN", message: "Admin access required" } },
        FALLBACK
      )
    ).toBe("Admin access required");
  });

  it("accepts a plain string error", () => {
    expect(apiErrorMessage({ error: "Nope" }, FALLBACK)).toBe("Nope");
  });

  it.each([
    ["no body", null],
    ["a body with no error", {}],
    ["an error with no message", { error: { code: "X" } }],
    ["a message that is not text", { error: { message: { nested: true } } }],
    ["an empty message", { error: { message: "" } }],
  ])("falls back for %s", (_label, body) => {
    expect(apiErrorMessage(body, FALLBACK)).toBe(FALLBACK);
  });

  it("always returns text a page can render", () => {
    expect(typeof apiErrorMessage({ error: { message: 5 } }, FALLBACK)).toBe(
      "string"
    );
  });
});

// The API's error body is `{ error: { code, message } }`. Passing `error`
// itself to `toast.error` hands React an object to render, and the page
// crashes with "Something Went Wrong". This fails when a component does that
// instead of calling `apiErrorMessage`.
const WEB_DIR = path.resolve(import.meta.dirname, "../..");

const COMPONENT_FILES = ["components", "app"]
  .flatMap((dir) =>
    (readdirSync(path.join(WEB_DIR, dir), { recursive: true }) as string[]).map(
      (file) => path.join(dir, file)
    )
  )
  .filter((file) => file.endsWith(".tsx"))
  .sort();

// `toast.error(body?.error ?? "…")`, `toast.error(data.error || "…")`, or
// `toast.error(body.error)`. Reading `.error.message` doesn't match.
const RAW_ERROR_TOAST = /toast\.error\(\s*\w+\??\.error\s*(?:\?\?|\|\||\))/;

describe("components that show a failed request in a toast", () => {
  it("covers the instrument and watcher dialogs", () => {
    expect(COMPONENT_FILES).toEqual(
      expect.arrayContaining([
        path.join("components", "instruments", "edit-instrument-dialog.tsx"),
        path.join("components", "instruments", "retire-instrument-dialog.tsx"),
        path.join(
          "components",
          "instruments",
          "reactivate-instrument-dialog.tsx"
        ),
        path.join("components", "watchers", "deregister-dialog.tsx"),
      ])
    );
  });

  it("never pass the API's error object to toast.error", () => {
    const offenders = COMPONENT_FILES.filter((file) =>
      RAW_ERROR_TOAST.test(readFileSync(path.join(WEB_DIR, file), "utf8"))
    );
    expect(offenders).toEqual([]);
  });
});
